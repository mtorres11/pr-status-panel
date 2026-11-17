import { afterEach, beforeEach, describe, mock, test } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_DEPLOY_UI, deployPatch, DeployUi, fetchPlan, SearchContext } from "../src/deployFilters";

const CTX: SearchContext = { viewer: "me", team: ["ann", "bob"], organizations: ["acme"], favoriteRepos: ["o/fav"] };
const ui = (over: Partial<DeployUi> = {}): DeployUi => ({ ...DEFAULT_DEPLOY_UI, ...over });

describe("deployPatch", () => {
  test("keeps valid keys, trims text, drops the rest", () => {
    const p = deployPatch({
      tab: "deploy",
      deployWho: " @anyone ",
      deployWhen: 14,
      deployState: "merged",
      deployRepo: "o/r",
      deployBranch: "release/1.0",
      deployFind: "  ABC-1 ",
      deployStage: " in:Prod ",
      other: 1,
    });
    assert.deepEqual(p, {
      tab: "deploy",
      deployWho: "@anyone",
      deployWhen: 14,
      deployState: "merged",
      deployRepo: "o/r",
      deployBranch: "release/1.0",
      deployFind: "ABC-1",
      deployStage: " in:Prod ",
    });
  });

  test("rejects invalid values", () => {
    const p = deployPatch({
      tab: "x",
      deployWho: "not valid!",
      deployWhen: 3,
      deployState: "closed",
      deployRepo: "bad",
      deployBranch: "a b",
      deployFind: "x".repeat(301),
      deployStage: "x".repeat(101),
    });
    assert.deepEqual(p, {});
  });
});

describe("fetchPlan", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-03-31T12:00:00Z") }));
  afterEach(() => mock.timers.reset());

  test("my open and merged PRs in the organizations, within the window", () => {
    assert.deepEqual(fetchPlan(ui(), CTX), {
      queries: [
        "is:pr archived:false is:open updated:>=2026-03-01 author:me org:acme",
        "is:pr archived:false is:merged merged:>=2026-03-01 author:me org:acme",
      ],
    });
  });

  test("one state, the team, one repo", () => {
    const plan = fetchPlan(ui({ deployWho: "@team", deployState: "open", deployRepo: "o/r", deployWhen: 7 }), CTX);
    assert.deepEqual(plan, {
      queries: [
        "is:pr archived:false is:open updated:>=2026-03-24 author:ann repo:o/r",
        "is:pr archived:false is:open updated:>=2026-03-24 author:bob repo:o/r",
      ],
    });
  });

  test("anyone and one person; favorites when there are no organizations", () => {
    const noOrgs = { ...CTX, organizations: [] };
    assert.deepEqual(fetchPlan(ui({ deployWho: "@anyone", deployState: "merged" }), noOrgs), {
      queries: ["is:pr archived:false is:merged merged:>=2026-03-01 repo:o/fav"],
    });
    assert.deepEqual(fetchPlan(ui({ deployWho: "zed", deployState: "merged" }), noOrgs), {
      queries: ["is:pr archived:false is:merged merged:>=2026-03-01 author:zed repo:o/fav"],
    });
  });

  test("hints when something is missing", () => {
    assert.ok("hint" in fetchPlan(ui({ deployWho: "@team" }), { ...CTX, team: [] }));
    const nowhere = { ...CTX, organizations: [], favoriteRepos: [] };
    assert.ok("hint" in fetchPlan(ui({ deployWho: "@anyone" }), nowhere));
    assert.ok("hint" in fetchPlan(ui({ deployFind: "ABC-1" }), nowhere));
  });

  test("find: a PR reference, a ticket key, or title words", () => {
    assert.deepEqual(fetchPlan(ui({ deployFind: "o/r#4" }), CTX), { pr: { repo: "o/r", number: 4 } });
    assert.deepEqual(fetchPlan(ui({ deployFind: "#4", deployRepo: "o/x" }), CTX), { pr: { repo: "o/x", number: 4 } });
    assert.deepEqual(fetchPlan(ui({ deployFind: "abc-12" }), CTX), {
      queries: ['is:pr archived:false "ABC-12" in:title org:acme'],
    });
    assert.deepEqual(fetchPlan(ui({ deployFind: 'fix "login"', deployState: "open" }), CTX), {
      queries: ['is:pr archived:false is:open updated:>=2026-03-01 author:me "fix login" in:title org:acme'],
    });
  });
});
