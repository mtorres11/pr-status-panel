import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import type { PrClient } from "../src/githubPrs";
import type { PrView } from "../src/model";
import { PrActions } from "../src/prActions";
import { fakeClient, fakeSettings, fakeUi } from "./fakes";
import { view } from "./helpers";

const API = { restBase: "r", graphqlUrl: "g", token: "t" };

function setup(prs: PrView[], opts: { confirm?: boolean; prompt?: string; signedOut?: boolean; client?: Partial<PrClient> } = {}) {
  const { ui, log } = fakeUi({ confirm: opts.confirm, prompt: opts.prompt });
  const { client, writes } = fakeClient(opts.client);
  const { settings, updates } = fakeSettings({ favoriteRepos: ["o/a"] });
  const soon: number[] = [];
  const actions = new PrActions({
    ui,
    settings,
    client,
    prs: {
      find: (id) => prs.find((p) => p.id === id),
      pick: (ids) => ids.map((id) => prs.find((p) => p.id === id)).filter((p): p is PrView => !!p),
    },
    github: async () => (opts.signedOut ? undefined : API),
    refreshSoon: (ms) => soon.push(ms),
  });
  return { actions, log, writes, updates, soon };
}

const ticketed = view({ id: "T", ticket: "AB-1", ticketUrl: "https://j/browse/AB-1" });

describe("copy", () => {
  test("copyUrl copies our own PR or ticket link", async () => {
    const { actions, log } = setup([ticketed, view({ id: "X", url: "javascript:alert(1)" })]);
    await actions.copyUrl("T", "pr");
    await actions.copyUrl("T", "ticket");
    await actions.copyUrl("X", "pr");
    await actions.copyUrl("nope", "pr");
    assert.deepEqual(log, [
      "copy: https://github.com/o/r/pull/1 | Copied PR #1 link",
      "copy: https://j/browse/AB-1 | Copied AB-1 link",
    ]);
  });

  test("copyLinks copies only known PRs in the group, in the order sent", async () => {
    const b = view({ id: "B", number: 2, url: "https://github.com/o/r/pull/2" });
    const draft = view({ id: "D", isDraft: true, status: "draft" });
    const { actions, log } = setup([ticketed, b, draft]);
    await actions.copyLinks(["B", "D", "T", "zzz"], "ready", "links");
    assert.deepEqual(log, [
      "copy: https://github.com/o/r/pull/2\nhttps://github.com/o/r/pull/1",
      "info: PR Status: copied 2 PR links.",
    ]);
  });

  test("copyLinks: the format is named; nothing to copy is said", async () => {
    const { actions, log } = setup([ticketed]);
    await actions.copyLinks(["T"], "all", "ticket");
    await actions.copyLinks(["T"], "ready", "markdown");
    await actions.copyLinks(["T"], "failing", "links");
    assert.equal(log[1], "info: PR Status: copied 1 PR link with tickets and titles.");
    assert.equal(log[3], "info: PR Status: copied 1 PR link as a Markdown list.");
    assert.equal(log[4], "info: PR Status: no PRs in this group in the list.");
  });
});

describe("rerun", () => {
  const failing = view({ id: "F", status: "failing", rerun: { failedRunIds: [7], allRunIds: [7, 8], failedExternal: 1 } });

  test("confirms, re-runs each workflow run, reports and refreshes soon", async () => {
    const { actions, log, writes, soon } = setup([failing]);
    await actions.rerun("F", false);
    assert.deepEqual(writes, ["rerun o/r 7 false", "rerun o/r 8 false"]);
    assert.equal(log[0], "confirm: Re-run all jobs in 2 workflow run(s) for o/r#1?");
    assert.equal(log.at(-1), "info: PR Status: restarted 2 workflow run(s) for #1. 1 failing non-Actions check(s) were skipped.");
    assert.deepEqual(soon, [5000]);
  });

  test("reports the runs GitHub refused", async () => {
    const { actions, log } = setup([failing], { client: { rerun: async () => Promise.reject(new Error("in progress")) } });
    await actions.rerun("F", true);
    assert.equal(log.at(-1), "error: PR Status: 0 of 1 run(s) restarted. run 7: in progress");
  });

  test("nothing to re-run, cancelled, unknown PR, signed out", async () => {
    const none = view({ id: "N" });
    const { actions, log, writes } = setup([none, failing], { confirm: false });
    await actions.rerun("N", true);
    await actions.rerun("N", false);
    await actions.rerun("F", true);
    await actions.rerun("zzz", true);
    assert.match(log[0], /none of the failing checks on #1 are GitHub Actions/);
    assert.match(log[1], /no GitHub Actions workflows are behind the checks/);
    assert.match(log[2], /^confirm: Re-run the failed jobs in 1/);
    assert.equal(log.length, 3);
    assert.deepEqual(writes, []);
    const out = setup([failing], { signedOut: true });
    await out.actions.rerun("F", true);
    assert.equal(out.log.at(-1), "error: PR Status: sign in to GitHub first.");
  });
});

describe("updateBranch", () => {
  const behind = view({ id: "U", canUpdateBranch: true, headOid: "abc" });

  test("merges or rebases with the head it saw, then refreshes", async () => {
    const { actions, log, writes, soon } = setup([behind]);
    await actions.updateBranch("U", "MERGE");
    await actions.updateBranch("U", "REBASE");
    assert.deepEqual(writes, ["update U abc MERGE", "update U abc REBASE"]);
    assert.equal(log[0], "confirm: Update o/r#1 onto the latest main?");
    assert.equal(log.at(-1), "info: PR Status: #1 is now up to date with main.");
    assert.deepEqual(soon, [4000, 4000]);
  });

  test("explains a moved head and other failures", async () => {
    const moved = setup([behind], { client: { updateBranch: async () => Promise.reject(new Error("expected head sha did not match")) } });
    await moved.actions.updateBranch("U", "MERGE");
    assert.match(moved.log.at(-1) ?? "", /changed since the last refresh/);
    const other = setup([behind], { client: { updateBranch: async () => Promise.reject(new Error("boom")) } });
    await other.actions.updateBranch("U", "MERGE");
    assert.equal(other.log.at(-1), "error: PR Status: could not update #1: boom");
  });

  test("up to date, cancelled, unknown, signed out", async () => {
    const { actions, log, writes } = setup([view({ id: "S" }), behind], { confirm: false });
    await actions.updateBranch("S", "MERGE");
    await actions.updateBranch("U", "MERGE");
    await actions.updateBranch("zzz", "MERGE");
    assert.equal(log[0], "info: PR Status: #1 is up to date with main, or you can't push to its branch.");
    assert.equal(log.length, 2);
    assert.deepEqual(writes, []);
    const out = setup([behind], { signedOut: true });
    await out.actions.updateBranch("U", "MERGE");
    assert.equal(out.log.at(-1), "error: PR Status: sign in to GitHub first.");
  });
});

describe("settings actions", () => {
  test("configureJira keeps the site and opens the ticket", async () => {
    const { actions, log, updates } = setup([], { prompt: "https://x.atlassian.net/jira/boards/1" });
    await actions.configureJira("AB-1");
    await actions.configureJira("bad ticket");
    assert.deepEqual(updates, [["jiraBaseUrl", "https://x.atlassian.net"], ["jiraBaseUrl", "https://x.atlassian.net"]]);
    assert.deepEqual(log.filter((l) => l.startsWith("open")), ["open: https://x.atlassian.net/browse/AB-1"]);
  });

  test("configureJira: cancelled or invalid input changes nothing", async () => {
    const cancelled = setup([]);
    await cancelled.actions.configureJira("AB-1");
    const invalid = setup([], { prompt: "https://" });
    await invalid.actions.configureJira("AB-1");
    assert.deepEqual([...cancelled.updates, ...invalid.updates], []);
    assert.ok(invalid.log.includes("validate: Enter a valid Jira URL"));
  });

  test("toggleFavorite stars and un-stars", async () => {
    const { actions, updates } = setup([]);
    await actions.toggleFavorite("o/b");
    await actions.toggleFavorite("o/a");
    assert.deepEqual(updates, [["favoriteRepos", ["o/a", "o/b"]], ["favoriteRepos", ["o/b"]]]);
  });
});
