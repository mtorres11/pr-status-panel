import { afterEach, beforeEach, describe, mock, test } from "node:test";
import * as assert from "node:assert/strict";
import { AwsError } from "../src/awsCli";
import type { BranchIndex } from "../src/deployGithub";
import { DEFAULT_DEPLOY_UI } from "../src/deployFilters";
import { DeployRequest, DeployService, DeployServiceDeps } from "../src/deployService";
import type { PipelineHistory } from "../src/pipelines";
import { deployRaw } from "./helpers";

const API = { restBase: "r", graphqlUrl: "g", token: "t" };
const MERGE = "m".repeat(40);
const LATER = "l".repeat(40);
const HEAD = "h".repeat(40);

const req = (over: Partial<DeployRequest> = {}): DeployRequest => ({
  ui: DEFAULT_DEPLOY_UI,
  api: API,
  search: { viewer: "me", team: [], organizations: ["o"], favoriteRepos: [] },
  ticketPattern: "[A-Z]+-\\d+",
  jiraBaseUrl: "https://j.io",
  aws: { cliPath: "aws", profile: "", region: "us-east-1" },
  pipelinePrefix: (repo) => `${repo.split("/")[1]}-`,
  ...over,
});

const index: BranchIndex = {
  branch: "main",
  since: "2026-01-01",
  position: new Map([[LATER, 0], [MERGE, 1], [HEAD, 2]]),
  commits: [
    { sha: LATER, message: "Later", date: "d" },
    { sha: MERGE, message: "ABC-1 Add thing (#5)", date: "d" },
    { sha: HEAD, message: "x", date: "d" },
  ],
};

const history = (name: string, sha: string): PipelineHistory => ({
  name,
  stages: [{ name: "Prod", runs: [{ sha, at: "2026-03-03T00:00:00Z", by: "ann" }] }],
});

function deps(over: Partial<DeployServiceDeps> = {}) {
  const asked: string[] = [];
  const d: DeployServiceDeps = {
    branches: {
      index: async () => index,
      isIn: async (_api, _repo, sha, ref, idx) => {
        const a = idx?.position.get(sha);
        const b = idx?.position.get(ref) ?? (ref === "main" ? 0 : undefined);
        return a !== undefined && b !== undefined ? b <= a : undefined;
      },
    },
    pipelines: {
      pipelines: async (_cfg, prefix) => (asked.push(prefix), ["r-api", "r-web"]),
      history: async (_cfg, name) => history(name, name === "r-api" ? LATER : HEAD),
    },
    prs: {
      search: async () => [deployRaw(), deployRaw({ id: "D1" }), deployRaw({ id: "C", state: "CLOSED" })],
      get: async () => undefined,
    },
    ...over,
  };
  return { d, asked };
}

describe("DeployService", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-03-10T00:00:00Z") }));
  afterEach(() => mock.timers.reset());

  test("a merged PR: ticket, in the branch, and the pipelines that picked it up", async () => {
    const { d, asked } = deps();
    const r = await new DeployService(d).load(req());
    assert.deepEqual(r.aws, { state: "ok" });
    assert.equal(r.prs.length, 1);
    const pr = r.prs[0];
    assert.equal(pr.ticket, "ABC-1");
    assert.equal(pr.ticketUrl, "https://j.io/browse/ABC-1");
    assert.equal(pr.inBranch, true);
    assert.equal(pr.revert, undefined);
    assert.equal(pr.pipelineCount, 2);
    assert.deepEqual(pr.tracks.map((t) => t.pipeline), ["r-api"]);
    assert.deepEqual(asked, ["r-"]);
  });

  test("an open PR is in the branch only when its head commit is", async () => {
    const { d } = deps({
      prs: { search: async () => [deployRaw({ state: "OPEN", mergedAt: null, mergeCommit: null }), deployRaw({ id: "O2", state: "OPEN", mergedAt: null, mergeCommit: null, headRefOid: "z" })], get: async () => undefined },
    });
    const r = await new DeployService(d).load(req());
    assert.deepEqual(r.prs.map((p) => p.inBranch), [true, undefined]);
    assert.deepEqual(r.prs[0].tracks, []);
  });

  test("AWS off, or failing: no pipelines and the reason", async () => {
    const off = await new DeployService(deps().d).load(req({ aws: undefined }));
    assert.deepEqual(off.aws, { state: "off" });
    assert.equal(off.prs[0].pipelineCount, 0);
    const signin = deps({ pipelines: { pipelines: async () => Promise.reject(new AwsError("expired", "signin")), history: async () => history("x", MERGE) } });
    assert.deepEqual((await new DeployService(signin.d).load(req())).aws, { state: "signin", message: "expired" });
    const other = deps({ pipelines: { pipelines: async () => Promise.reject(new AwsError("weird", "other")), history: async () => history("x", MERGE) } });
    assert.deepEqual((await new DeployService(other.d).load(req())).aws, { state: "error", message: "weird" });
    const plain = deps({ pipelines: { pipelines: async () => Promise.reject(new Error("boom")), history: async () => history("x", MERGE) } });
    assert.deepEqual((await new DeployService(plain.d).load(req())).aws, { state: "error", message: "boom" });
  });

  test("after an AWS failure the other repos skip AWS", async () => {
    let calls = 0;
    const { d } = deps({
      prs: { search: async () => [deployRaw(), deployRaw({ id: "B", repository: { nameWithOwner: "o/b" } })], get: async () => undefined },
      pipelines: { pipelines: async () => (calls++, Promise.reject(new AwsError("expired", "signin"))), history: async () => history("x", MERGE) },
    });
    await new DeployService(d).load(req());
    assert.equal(calls, 1);
  });

  test("a PR reference fetches that PR, or says it was not found", async () => {
    const found = deps({ prs: { search: async () => [], get: async (_api, repo, n) => deployRaw({ number: n, repository: { nameWithOwner: repo } }) } });
    const r = await new DeployService(found.d).load(req({ ui: { ...DEFAULT_DEPLOY_UI, deployFind: "o/r#5" } }));
    assert.equal(r.prs[0].number, 5);
    const missing = await new DeployService(deps().d).load(req({ ui: { ...DEFAULT_DEPLOY_UI, deployFind: "o/r#6" } }));
    assert.equal(missing.hint, "o/r#6 was not found, or this account cannot see it.");
  });

  test("a plan hint comes back as is", async () => {
    const r = await new DeployService(deps().d).load(req({ ui: { ...DEFAULT_DEPLOY_UI, deployWho: "@team" } }));
    assert.match(r.hint ?? "", /No team yet/);
    assert.deepEqual(r.prs, []);
  });

  test("a revert later in the branch, and a missing branch index", async () => {
    const reverted: BranchIndex = { ...index, commits: [{ sha: LATER, message: 'Revert "ABC-1 Add thing (#5)"', date: "d2" }, ...index.commits.slice(1)] };
    const { d } = deps({ branches: { ...deps().d.branches, index: async () => reverted } });
    assert.equal((await new DeployService(d).load(req())).prs[0].revert?.sha, LATER);
    const noIndex = deps({ branches: { index: async () => Promise.reject(new Error("x")), isIn: async () => undefined } });
    const pr = (await new DeployService(noIndex.d).load(req())).prs[0];
    assert.equal(pr.inBranch, undefined);
  });

  test("the default readers can be built", () => {
    assert.ok(new DeployService());
  });
});
