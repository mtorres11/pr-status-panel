import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import type { StageCell } from "../src/deployLocation";
import type { DeployPr } from "../src/deployService";
import { matchesWhere, summarize, whereOf } from "../src/deploySummary";

const cell = (name: string, state: StageCell["state"], firstAt?: string): StageCell => ({ name, state, firstAt, by: firstAt ? "ann" : undefined });

const pr = (over: Partial<DeployPr> = {}): DeployPr => ({
  id: "1",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  author: "me",
  state: "MERGED",
  isDraft: false,
  createdAt: "c",
  updatedAt: "u",
  inBranch: true,
  tracks: [],
  ...over,
});

const twoPipes = pr({
  tracks: [
    { pipeline: "api", stages: [cell("Dev", "deployed", "2026-01-02"), cell("Prod", "deployed", "2026-01-05")] },
    { pipeline: "web", stages: [cell("Dev", "deployed", "2026-01-01"), cell("Prod", "not-yet")] },
  ],
});

describe("whereOf", () => {
  test("open, reverted, not in the branch, merged", () => {
    assert.equal(whereOf(pr({ state: "OPEN" })), "open");
    assert.equal(whereOf(pr({ revert: { sha: "s", date: "d", message: "m" } })), "reverted");
    assert.equal(whereOf(pr({ inBranch: false })), "missing");
    assert.equal(whereOf(pr()), "merged");
  });

  test("on the way until every pipeline has the last stage", () => {
    assert.equal(whereOf(twoPipes), "partial");
    const done = pr({ tracks: [{ pipeline: "api", stages: [cell("Dev", "deployed", "a"), cell("Prod", "deployed", "b")] }] });
    assert.equal(whereOf(done), "done");
    const none = pr({ tracks: [{ pipeline: "api", stages: [cell("Dev", "not-yet"), cell("Prod", "unknown")] }] });
    assert.equal(whereOf(none), "merged");
  });
});

describe("matchesWhere", () => {
  test("fixed filters", () => {
    assert.equal(matchesWhere(pr(), ""), true);
    assert.equal(matchesWhere(pr({ state: "OPEN" }), "open"), true);
    assert.equal(matchesWhere(pr(), "inBranch"), true);
    assert.equal(matchesWhere(pr({ inBranch: false }), "notInBranch"), true);
    assert.equal(matchesWhere(pr(), "reverted"), false);
  });

  test("in a stage, not yet in it, and unknown filters", () => {
    assert.equal(matchesWhere(twoPipes, "in:Prod"), true);
    assert.equal(matchesWhere(twoPipes, "notin:Prod"), true);
    assert.equal(matchesWhere(twoPipes, "notin:Dev"), false);
    assert.equal(matchesWhere(twoPipes, "in:Nope"), false);
    assert.equal(matchesWhere(pr({ state: "OPEN" }), "in:Dev"), false);
    assert.equal(matchesWhere(twoPipes, "weird"), false);
  });
});

describe("summarize", () => {
  test("list-wide stage names, per-PR summaries in that order, and the filter", () => {
    const s = summarize([pr({ id: "x", tracks: [{ pipeline: "p", stages: [cell("QA", "deployed", "z")] }] }), twoPipes], "in:Prod");
    assert.deepEqual(s.stageNames, ["QA", "Dev", "Prod"]);
    const [first, second] = s.prs;
    assert.deepEqual(first.stages.map((x) => x.total), [1, 0, 0]);
    assert.equal(first.shown, false);
    assert.deepEqual(second.stages[1], { name: "Dev", total: 2, deployed: 2, first: cell("Dev", "deployed", "2026-01-01") });
    assert.equal(second.where, "partial");
    assert.equal(second.shown, true);
  });
});
