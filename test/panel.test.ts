import { describe, mock, test } from "node:test";
import * as assert from "node:assert/strict";
import type { DeployRequest, DeployService } from "../src/core/deployService";
import type { PrClient } from "../src/core/githubPrs";
import { Panel } from "../src/core/panel";
import type { HostMessage, Payload } from "../src/core/protocol";
import { fakeAuth, fakeClient, fakeSettings, fakeUi, memoryStore } from "./fakes";
import { rawPr } from "./helpers";

function setup(opts: { client?: Partial<PrClient>; prompt?: string; signedOut?: boolean; now?: () => number } = {}) {
  const { ui, log } = fakeUi({ prompt: opts.prompt });
  const { settings, updates } = fakeSettings({ teamMembers: ["ann"], favoriteRepos: ["o/a"] });
  const { auth } = fakeAuth({ github: [{ id: "1", label: "me" }] }, { signedOut: opts.signedOut });
  const searches: string[] = [];
  const { client, writes } = fakeClient({
    search: async (_api, q) => (searches.push(q), [rawPr({ title: "ABC-1 Thing", headRefName: "abc-1" })]),
    ...opts.client,
  });
  const deployLoads: DeployRequest[] = [];
  const deployService = { load: async (r: DeployRequest) => (deployLoads.push(r), { prs: [], aws: { state: "ok" } }) } as unknown as DeployService;
  const store = memoryStore();
  const panel = new Panel({
    ui,
    settings,
    auth,
    store,
    about: { author: "A", repoUrl: "https://x", version: "1" },
    client,
    deployService,
    now: opts.now,
  });
  const posts: Payload[] = [];
  panel.attach({ post: (m: HostMessage) => void posts.push(m.payload) });
  const last = () => posts[posts.length - 1];
  return { panel, log, updates, searches, writes, deployLoads, posts, last, store, settings };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("Panel", () => {
  test("ready: posts, then loads the PR tab", async () => {
    const s = setup();
    await s.panel.onMessage({ type: "ready" });
    await settle();
    assert.deepEqual(s.searches, ["is:pr is:open archived:false author:me"]);
    const p = s.last();
    assert.equal(p.prs.length, 1);
    assert.equal(p.prs[0].ticket, "ABC-1");
    assert.equal(p.viewerLogin, "me");
    assert.equal(p.ui.accountKey, "github:1");
    assert.deepEqual(p.accounts, [{ key: "github:1", label: "me (github.com)" }]);
    assert.deepEqual(p.favorites, ["o/a"]);
    assert.equal(p.needsSignIn, false);
    assert.equal(p.about.author, "A");
    assert.equal(p.deploy.loading, false);
    assert.deepEqual(p.options.sort.map(([v]) => v), ["attention", "updated", "ticket"]);
    assert.deepEqual(p.prs[0].copyGroups, ["approval", "waiting", "all"]);
  });

  test("display-only changes only redraw; filter changes reload; invalid patches redraw", async () => {
    const s = setup();
    await s.panel.onMessage({ type: "setState", patch: { copyFormat: "markdown" } });
    assert.equal(s.searches.length, 0);
    assert.equal(s.last().ui.copyFormat, "markdown");
    await s.panel.onMessage({ type: "setState", patch: { sort: "bogus" } });
    assert.equal(s.searches.length, 0);
    await s.panel.onMessage({ type: "setState", patch: { show: "review" } });
    assert.deepEqual(s.searches, ["is:pr is:open archived:false review-requested:me"]);
  });

  test("'Other user…' asks for the login", async () => {
    const ok = setup({ prompt: " @octo " });
    await ok.panel.onMessage({ type: "setState", patch: { author: "@other" } });
    assert.equal(ok.last().ui.author, "octo");
    assert.deepEqual(ok.searches, ["is:pr is:open archived:false author:octo"]);
    const bad = setup({ prompt: "not valid!" });
    await bad.panel.onMessage({ type: "setState", patch: { author: "@other" } });
    assert.equal(bad.last().ui.author, "@me");
    assert.ok(bad.log.includes("validate: Not a valid GitHub username"));
  });

  test("tabs: switching loads the Deployments tab when stale; its filters reload it", async () => {
    let clock = 10_000_000;
    const s = setup({ now: () => clock });
    await s.panel.onMessage({ type: "setState", patch: { tab: "deploy" } });
    assert.equal(s.deployLoads.length, 1);
    await s.panel.onMessage({ type: "setState", patch: { deployState: "open" } });
    assert.equal(s.deployLoads.length, 2);
    await s.panel.onMessage({ type: "refresh" });
    assert.equal(s.deployLoads.length, 3);
    s.panel.refreshIfStale();
    assert.equal(s.deployLoads.length, 3);
    clock += 60_001;
    s.panel.refreshIfStale();
    await settle();
    assert.equal(s.deployLoads.length, 4);
    assert.equal(s.searches.length, 0);
  });

  test("switching to a fresh tab only redraws", async () => {
    const s = setup({ now: () => 0 });
    await s.panel.onMessage({ type: "setState", patch: { tab: "deploy" } });
    s.panel.refreshIfStale();
    assert.equal(s.deployLoads.length, 0);
  });

  test("settings: fetch-relevant changes refresh, favorites only redraw", async () => {
    const s = setup();
    const before = s.posts.length;
    await s.settings.update("favoriteRepos", ["o/b"]);
    assert.equal(s.panel.settingsChanged(), false);
    assert.equal(s.posts.length, before + 1);
    await s.settings.update("compact", true);
    assert.equal(s.panel.settingsChanged(), true);
    await settle();
    assert.equal(s.searches.length, 1);
    assert.equal(s.panel.refreshIntervalMs, 60_000);
  });

  test("messages reach the PR actions and the editor", async () => {
    const s = setup();
    await s.panel.refreshActive(true);
    const id = s.last().prs[0].id;
    await s.panel.onMessage({ type: "copyUrl", prId: id, which: "pr" });
    await s.panel.onMessage({ type: "copyLinks", ids: [id], group: "all", format: "links" });
    await s.panel.onMessage({ type: "open", url: "https://github.com" });
    await s.panel.onMessage({ type: "toggleFavorite", repo: "o/c" });
    await s.panel.onMessage({ type: "configureJira", ticket: "ABC-1" });
    await s.panel.onMessage({ type: "openSettings" });
    await s.panel.onMessage({ type: "awsSignIn" });
    await s.panel.onMessage({ type: "awsProfile" });
    assert.ok(s.log.includes("copy: https://github.com/o/r/pull/1 | Copied PR #1 link"));
    assert.ok(s.log.includes("open: https://github.com"));
    assert.ok(s.log.includes("settings: "));
    assert.ok(s.log.includes("settings: prStatus.aws.loginCommand"));
    assert.deepEqual(s.updates[0], ["favoriteRepos", ["o/a", "o/c"]]);
  });

  test("re-run and update branch refresh a little later", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let searches = 0;
      const s = setup({ client: { search: async () => (searches++, [rawPr({ viewerCanUpdateBranch: true })]) } });
      await s.panel.refreshActive(true);
      const id = s.last().prs[0].id;
      await s.panel.onMessage({ type: "updateBranch", prId: id, method: "merge" });
      await s.panel.onMessage({ type: "rerun", prId: id, mode: "all" });
      assert.deepEqual(s.writes, ["update PR_1 undefined MERGE"]);
      const before = searches;
      mock.timers.tick(4000);
      await settle();
      assert.equal(searches, before + 1);
    } finally {
      mock.timers.reset();
    }
  });

  test("sign in and add account refresh after success", async () => {
    const s = setup({ signedOut: true });
    await s.panel.refreshActive(true);
    assert.equal(s.last().needsSignIn, true);
    await s.panel.onMessage({ type: "signIn" });
    await s.panel.onMessage({ type: "addAccount" });
    await settle();
    assert.equal(s.searches.length, 0);
  });

  test("nothing happens without a view", async () => {
    const s = setup();
    s.panel.detach();
    await s.panel.onMessage({ type: "refresh" });
    await s.panel.refreshActive(true);
    assert.equal(s.searches.length, 0);
  });
});
