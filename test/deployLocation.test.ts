import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import type { BranchIndex } from "../src/core/deployGithub";
import { containsFn, findRevert, trackFor } from "../src/core/deployLocation";
import type { PipelineHistory } from "../src/core/pipelines";

/** Commits c0 (oldest) … c9: `sha` is in `ref` when its number is not larger. */
function linear() {
  const asked: string[] = [];
  const contains = async (sha: string, ref: string) => {
    asked.push(ref);
    if (ref === "unknown") return undefined;
    return Number(sha.slice(1)) <= Number(ref.slice(1));
  };
  return { asked, contains };
}

const runs = (...shas: string[]) => shas.map((sha, i) => ({ sha, at: `2026-01-0${i + 1}`, by: `p${i}` }));

describe("trackFor", () => {
  const history: PipelineHistory = {
    name: "app-pipe",
    stages: [
      { name: "Dev", runs: runs("c1", "c2", "c3", "c4", "c5", "c6", "c7"), latestStatus: "Succeeded" },
      { name: "Prod", runs: runs("c1", "c2"), latestStatus: "InProgress" },
      { name: "Empty", runs: [] },
      { name: "Odd", runs: runs("unknown") },
    ],
  };

  test("finds the first run containing the change with a bisect", async () => {
    const { asked, contains } = linear();
    const t = await trackFor(history, "c4", contains);
    assert.equal(t.pipeline, "app-pipe");
    assert.deepEqual(t.stages[0], { name: "Dev", latestStatus: undefined, state: "deployed", firstAt: "2026-01-04", by: "p3", orEarlier: false });
    // the latest run, then a bisect over 7 runs: 3 probes, not 7
    assert.deepEqual(asked.slice(0, 4), ["c7", "c4", "c2", "c3"]);
  });

  test("not yet, no runs, unknown; keeps a non-success latest status", async () => {
    const t = await trackFor(history, "c4", linear().contains);
    assert.deepEqual(t.stages[1], { name: "Prod", latestStatus: "InProgress", state: "not-yet" });
    assert.deepEqual(t.stages[2], { name: "Empty", latestStatus: undefined, state: "unknown" });
    assert.deepEqual(t.stages[3], { name: "Odd", latestStatus: undefined, state: "unknown" });
  });

  test("orEarlier when even the oldest run has it", async () => {
    const t = await trackFor(history, "c0", linear().contains);
    assert.equal(t.stages[0].orEarlier, true);
    assert.equal(t.stages[0].firstAt, "2026-01-01");
  });
});

describe("findRevert", () => {
  const idx: BranchIndex = {
    branch: "main",
    since: "2026-01-01",
    position: new Map([["r2", 0], ["r1", 1], ["m", 2], ["old", 3]]),
    commits: [
      { sha: "r2", message: 'Revert "Other (#9)"', date: "d2" },
      { sha: "r1", message: 'Revert "Add thing (#5)"', date: "d1" },
      { sha: "m", message: "Add thing (#5)", date: "d0" },
      { sha: "old", message: 'Revert "Add thing (#5)"', date: "dx" },
    ],
  };

  test("a later revert of the PR", () => {
    assert.deepEqual(findRevert(idx, "m", 5), { sha: "r1", date: "d1", message: 'Revert "Add thing (#5)"' });
  });

  test("nothing when not reverted, not indexed, or no index", () => {
    assert.equal(findRevert(idx, "m", 6), undefined);
    assert.equal(findRevert(idx, "zzz", 5), undefined);
    assert.equal(findRevert(undefined, "m", 5), undefined);
  });
});

describe("containsFn", () => {
  test("asks the branch commits with the repo and index", async () => {
    const calls: unknown[][] = [];
    const branches = { isIn: async (...args: unknown[]) => (calls.push(args), true) } as never;
    const api = { restBase: "r", graphqlUrl: "g", token: "t" };
    assert.equal(await containsFn(branches, api, "o/r")("a", "b"), true);
    assert.deepEqual(calls, [[api, "o/r", "a", "b", undefined]]);
  });
});
