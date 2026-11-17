import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { accountKey, GitHubAuth } from "../src/core/githubAuth";
import { UiStateStore } from "../src/core/uiState";
import { fakeAuth, fakeUi, memoryStore } from "./fakes";

const ANN = { id: "1", label: "ann" };
const BOB = { id: "2", label: "bob" };

function setup(enterprise = "", opts: Parameters<typeof fakeAuth>[1] = {}, pick?: (items: { label: string }[]) => unknown) {
  const { auth, calls } = fakeAuth({ github: [ANN, BOB], "github-enterprise": [{ id: "9", label: "corp" }] }, opts);
  const { ui, log } = fakeUi({ pick });
  const store = memoryStore();
  const uiState = new UiStateStore(store);
  let viewerCalls = 0;
  const gh = new GitHubAuth({
    auth,
    ui,
    uiState,
    enterpriseUri: () => enterprise,
    viewerLogin: async (api) => (viewerCalls++, `login-of-${api.token}`),
  });
  return { gh, calls, log, store, uiState, viewers: () => viewerCalls };
}

describe("GitHubAuth", () => {
  test("lists github.com accounts, and Enterprise ones only when set up", async () => {
    const plain = setup();
    await plain.gh.connect();
    assert.deepEqual(plain.gh.accounts.map((a) => a.label), ["ann (github.com)", "bob (github.com)"]);
    const ent = setup("https://ghe.io");
    await ent.gh.connect();
    assert.deepEqual(ent.gh.accounts.map((a) => a.key), ["github:1", "github:2", "github-enterprise:9"]);
  });

  test("connects the chosen account and caches its login", async () => {
    const s = setup();
    await s.uiState.update({ accountKey: "github:2" });
    const c = await s.gh.connect();
    assert.equal(c?.key, "github:2");
    assert.equal(c?.api.restBase, "https://api.github.com");
    assert.equal(c?.viewer, "login-of-token-2");
    await s.gh.connect();
    assert.equal(s.viewers(), 1);
    assert.equal(s.gh.needsSignIn, false);
    assert.deepEqual(s.calls[0].options, { account: BOB, silent: true });
  });

  test("an Enterprise account talks to the Enterprise server", async () => {
    const s = setup("https://ghe.io");
    await s.uiState.update({ accountKey: "github-enterprise:9" });
    assert.equal((await s.gh.connect())?.api.restBase, "https://ghe.io/api/v3");
  });

  test("signed out: no connection and a sign-in prompt", async () => {
    const s = setup("", { signedOut: true });
    assert.equal(await s.gh.connect(), undefined);
    assert.equal(s.gh.needsSignIn, true);
  });

  test("sign in renews the current account; add account asks which GitHub", async () => {
    const s = setup("https://ghe.io", {}, (items) => items[1]);
    await s.gh.connect();
    assert.equal(await s.gh.signIn(false), true);
    assert.deepEqual(s.calls.at(-1), { providerId: "github", options: { createIfNone: true, account: ANN } });
    assert.equal(await s.gh.signIn(true), true);
    assert.deepEqual(s.calls.at(-1), { providerId: "github-enterprise", options: { createIfNone: true, clearSessionPreference: true } });
    assert.equal(s.uiState.get().accountKey, accountKey("github-enterprise", "9"));
  });

  test("add account without Enterprise goes straight to github.com; cancelling the pick does nothing", async () => {
    const s = setup();
    assert.equal(await s.gh.signIn(true), true);
    assert.equal(s.calls.at(-1)?.providerId, "github");
    const cancel = setup("https://ghe.io", {}, () => undefined);
    assert.equal(await cancel.gh.signIn(true), false);
    assert.equal(cancel.calls.length, 0);
  });

  test("a failed sign-in is reported", async () => {
    const s = setup("", { fail: "denied" });
    assert.equal(await s.gh.signIn(false), false);
    assert.deepEqual(s.log, ["error: PR Status: sign-in failed: denied"]);
  });
});
