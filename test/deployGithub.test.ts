import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { BranchCommits, getDeployPr, searchDeployPrs } from "../src/core/deployGithub";
import { apiTargetFor } from "../src/core/github";
import { stubFetch } from "./fakes";

const API = apiTargetFor(undefined, "tok");
const A = "a".repeat(40);
const B = "b".repeat(40);
let restore = () => undefined as void;
afterEach(() => restore());

describe("Deployments PR reads", () => {
  test("search and one PR", async () => {
    const s = stubFetch((c) => {
      const vars = (c.body as { variables: Record<string, unknown> }).variables;
      if ("number" in vars) return { json: { data: { repository: { pullRequest: { id: "one" } } } } };
      return { json: { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "x" }] } } } };
    });
    restore = s.restore;
    assert.deepEqual(await searchDeployPrs(API, "q"), [{ id: "x" }]);
    assert.deepEqual(await getDeployPr(API, "o/r", 5), { id: "one" });
    assert.deepEqual((s.calls[1].body as { variables: unknown }).variables, { owner: "o", name: "r", number: 5 });
  });

  test("a PR that is not there", async () => {
    restore = stubFetch(() => ({ json: { data: { repository: null } } })).restore;
    assert.equal(await getDeployPr(API, "o/r", 5), undefined);
  });
});

describe("BranchCommits", () => {
  const commit = (sha: string, message: string) => ({ sha, commit: { message, committer: { date: "2026-01-01" } } });

  test("indexes a branch's commits (paged, cached) and answers from the index", async () => {
    const full = Array.from({ length: 100 }, (_, i) => commit(`${i}`.padStart(40, "0"), `c${i}\nbody`));
    const s = stubFetch((c) => ({ json: /page=1$/.test(c.url) ? full : [commit(A, "last")] }));
    restore = s.restore;
    const bc = new BranchCommits();
    const idx = await bc.index(API, "o/r", "main", "2026-01-01T00:00:00Z");
    assert.equal(idx?.commits.length, 101);
    assert.equal(idx?.commits[0].message, "c0");
    assert.equal(idx?.position.get(A), 100);
    await bc.index(API, "o/r", "main", "2026-01-01T09:00:00Z");
    assert.equal(s.calls.length, 2);
    assert.equal(await bc.isIn(API, "o/r", A, "main", idx), true);
    assert.equal(await bc.isIn(API, "o/r", A, full[0].sha, idx), true);
    assert.equal(await bc.isIn(API, "o/r", full[0].sha, A, idx), false);
    assert.equal(s.calls.length, 2);
  });

  test("an unknown branch has no index", async () => {
    restore = stubFetch(() => ({ status: 404, json: {} })).restore;
    assert.equal(await new BranchCommits().index(API, "o/r", "nope", "2026-01-01"), undefined);
    restore();
    restore = stubFetch(() => ({ json: [] })).restore;
    assert.equal(await new BranchCommits().index(API, "o/r", "empty", "2026-01-01"), undefined);
  });

  test("falls back to a compare call, caching answers for commit pairs only", async () => {
    const s = stubFetch((c) => ({ json: { status: c.url.includes(`...${B}`) ? "ahead" : c.url.includes("...main") ? "identical" : "behind" } }));
    restore = s.restore;
    const bc = new BranchCommits();
    assert.equal(await bc.isIn(API, "o/r", A, B), true);
    assert.equal(await bc.isIn(API, "o/r", A, B), true);
    assert.equal(await bc.isIn(API, "o/r", A, "main"), true);
    assert.equal(await bc.isIn(API, "o/r", A, "main"), true);
    assert.equal(await bc.isIn(API, "o/r", A, "dev"), false);
    assert.equal(s.calls.length, 4);
    restore();
    restore = stubFetch(() => ({ status: 404, json: {} })).restore;
    assert.equal(await bc.isIn(API, "o/r", B, A), undefined);
  });
});
