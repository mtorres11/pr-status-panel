import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { readConfig } from "../src/core/config";
import { GitHubAuth } from "../src/core/githubAuth";
import type { PrClient } from "../src/core/githubPrs";
import { PrTab } from "../src/core/prTab";
import { DEFAULT_UI, PrUi, UiStateStore } from "../src/core/uiState";
import { fakeAuth, fakeClient, fakeSettings, fakeUi, memoryStore } from "./fakes";
import { rawPr } from "./helpers";

function setup(over: Partial<PrClient> = {}, effective: Record<string, unknown> = {}, signedOut = false) {
  const { auth } = fakeAuth({ github: [{ id: "1", label: "me" }] }, { signedOut });
  const uiState = new UiStateStore(memoryStore());
  const gh = new GitHubAuth({ auth, ui: fakeUi().ui, uiState, enterpriseUri: () => "", viewerLogin: async () => "me" });
  const { client } = fakeClient(over);
  const { settings } = fakeSettings(effective);
  let ui: PrUi = DEFAULT_UI;
  let changes = 0;
  const tab = new PrTab({
    client,
    auth: gh,
    config: () => readConfig(settings),
    ui: () => ui,
    changed: () => changes++,
    now: () => 1000,
  });
  return { tab, setUi: (u: Partial<PrUi>) => (ui = { ...ui, ...u }), changes: () => changes };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("PrTab", () => {
  test("searches, de-duplicates and builds the cards", async () => {
    const searched: string[] = [];
    const { tab, setUi } = setup({
      search: async (_api, q) => (searched.push(q), [rawPr({ id: "A" }), rawPr({ id: "B", repository: { nameWithOwner: "o/b" } })]),
      repos: async () => ["o/r", "x/y"],
    });
    setUi({ show: "all" });
    await tab.refresh(true);
    await settle();
    const v = tab.view("github:1");
    assert.equal(searched.length, 3);
    assert.deepEqual(v.prs.map((p) => p.id), ["A", "B"]);
    assert.equal(v.updatedAt, 1000);
    assert.equal(v.loading, false);
    assert.deepEqual(v.repos, ["o/b", "o/r", "x/y"]);
    assert.equal(tab.lastRefresh, 1000);
    assert.equal(tab.find("B")?.repo, "o/b");
    assert.deepEqual(tab.pick(["B", "nope", "A"]).map((p) => p.id), ["B", "A"]);
  });

  test("fills in pending code-owner team members, once per team (cached), and leaves unknown teams empty", async () => {
    const asked: string[] = [];
    const ownerTeam = (slug: string) => ({
      asCodeOwner: true,
      requestedReviewer: { __typename: "Team" as const, name: slug, slug, organization: { login: "acme" } },
    });
    const pr = (id: string) => rawPr({ id, reviewRequests: { nodes: [ownerTeam("ai-team"), ownerTeam("hidden")] } });
    const { tab } = setup({
      search: async () => [pr("A"), pr("B")],
      teamMembers: async (_api, org, slug) => {
        asked.push(`${org}/${slug}`);
        if (slug === "hidden") throw new Error("not visible");
        return [{ login: "ana", name: "Ana Ruiz" }, { login: "bo" }];
      },
    });
    await tab.refresh(true);
    await tab.refresh(true);
    await settle();
    const teams = tab.view(undefined).prs.map((p) => p.approvals.pendingOwnerTeams);
    for (const t of teams) {
      assert.deepEqual(t[0].members, [{ login: "ana", name: "Ana Ruiz" }, { login: "bo" }]);
      assert.equal(t[1].members, undefined, "a team this account cannot see has no member list");
    }
    assert.deepEqual([...new Set(asked)].sort(), ["acme/ai-team", "acme/hidden"]);
    assert.ok(asked.length <= 4, "the second refresh reuses the cache");
  });

  test("repo choices keep the organizations only", async () => {
    const { tab } = setup({ search: async () => [rawPr()], repos: async () => ["acme/a", "other/b"] }, { organizations: ["ACME"] });
    await tab.refresh(true);
    await settle();
    assert.deepEqual(tab.view("github:1").repos, ["acme/a", "o/r"]);
    assert.deepEqual(tab.view(undefined).repos, ["o/r"]);
  });

  test("required approvals: per-repo setting, branch rules (cached), branch protection, default", async () => {
    let ruleCalls = 0;
    const prs = [
      rawPr({ id: "1", repository: { nameWithOwner: "o/set" } }),
      rawPr({ id: "2", repository: { nameWithOwner: "o/rules" } }),
      rawPr({ id: "3", repository: { nameWithOwner: "o/prot" }, baseRef: { branchProtectionRule: { requiredApprovingReviewCount: 3 } } }),
      rawPr({ id: "4", repository: { nameWithOwner: "o/none" } }),
    ];
    const { tab } = setup(
      {
        search: async () => prs,
        requiredApprovals: async (_api, repo) => (ruleCalls++, repo === "o/rules" ? 4 : undefined),
      },
      { requiredApprovalsPerRepo: { "o/set": 5 }, requiredApprovals: 2 },
    );
    await tab.refresh(true);
    await tab.refresh(true);
    assert.deepEqual(tab.view(undefined).prs.map((p) => p.approvals.required), [5, 4, 3, 2]);
    assert.equal(ruleCalls, 3);
  });

  test("signed out: empty list", async () => {
    const { tab } = setup({ search: async () => [rawPr()] }, {}, true);
    await tab.refresh(true);
    assert.deepEqual(tab.view(undefined).prs, []);
  });

  test("errors are shown and the old list kept; clear drops it", async () => {
    let fail = false;
    const { tab } = setup({
      search: async () => {
        if (fail) throw new Error("rate limited");
        return [rawPr()];
      },
      repos: async () => {
        throw new Error("no repos");
      },
    });
    await tab.refresh(true);
    fail = true;
    await tab.refresh(true);
    assert.equal(tab.view(undefined).error, "rate limited");
    assert.equal(tab.view(undefined).prs.length, 1);
    tab.clear();
    assert.equal(tab.view(undefined).prs.length, 0);
  });

  test("a newer refresh wins over a slower older one", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let call = 0;
    const { tab } = setup({
      search: async () => {
        const mine = ++call;
        if (mine === 1) await slow;
        return [rawPr({ id: `run${mine}` })];
      },
    });
    const first = tab.refresh(true);
    await settle();
    await tab.refresh(true);
    release();
    await first;
    assert.deepEqual(tab.view(undefined).prs.map((p) => p.id), ["run2"]);
  });
});
