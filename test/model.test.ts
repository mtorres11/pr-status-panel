import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { ModelOptions, toView } from "../src/model";
import { rawPr, run, status } from "./helpers";

const OPTS: ModelOptions = {
  ticketPattern: "[A-Z][A-Z0-9]+-\\d+",
  jiraBaseUrl: "https://x.atlassian.net/jira/boards/1",
  ignoredChecks: [],
  ignoreBotThreads: false,
};

describe("toView: ticket", () => {
  test("takes the key from the branch first, then the title, upper-cased", () => {
    const lower = { ...OPTS, ticketPattern: "[a-z]+-\\d+" };
    assert.equal(toView(rawPr({ headRefName: "abc-1-x" }), 1, lower).ticket, "ABC-1");
    assert.equal(toView(rawPr({ headRefName: "ABC-1-x", title: "XYZ-9 t" }), 1, OPTS).ticket, "ABC-1");
    assert.equal(toView(rawPr({ headRefName: "feature", title: "XYZ-9 t" }), 1, OPTS).ticket, "XYZ-9");
  });

  test("builds the Jira link from the site part of the setting", () => {
    const v = toView(rawPr({ headRefName: "ABC-1" }), 1, OPTS);
    assert.equal(v.ticketUrl, "https://x.atlassian.net/browse/ABC-1");
  });

  test("no link without a Jira site, no ticket with a broken pattern", () => {
    assert.equal(toView(rawPr({ headRefName: "ABC-1" }), 1, { ...OPTS, jiraBaseUrl: "" }).ticketUrl, undefined);
    assert.equal(toView(rawPr({ headRefName: "ABC-1" }), 1, { ...OPTS, ticketPattern: "(" }).ticket, undefined);
  });
});

describe("toView: checks", () => {
  const contexts = [
    run("b-pass", "COMPLETED", "SUCCESS", 10),
    run("a-fail", "COMPLETED", "FAILURE", 11),
    run("timeout", "COMPLETED", "TIMED_OUT"),
    run("skip", "COMPLETED", "SKIPPED"),
    run("neutral", "COMPLETED", "NEUTRAL"),
    run("going", "IN_PROGRESS", null, 12),
    run("queued", "QUEUED"),
    status("ci/ok", "SUCCESS"),
    status("ci/bad", "ERROR"),
    status("ci/wait", "PENDING"),
  ];

  test("classifies and counts every check", () => {
    const c = toView(rawPr({}, contexts), 1, OPTS).checks;
    assert.deepEqual(
      { passed: c.passed, failed: c.failed, running: c.running, pending: c.pending, skipped: c.skipped, total: c.total },
      { passed: 2, failed: 3, running: 1, pending: 2, skipped: 2, total: 10 },
    );
  });

  test("sorts failed, running, pending, passed, skipped, then by name", () => {
    const names = toView(rawPr({}, contexts), 1, OPTS).checks.items.map((i) => i.name);
    assert.deepEqual(names, ["a-fail", "ci/bad", "timeout", "going", "ci/wait", "queued", "b-pass", "ci/ok", "neutral", "skip"]);
  });

  test("drops ignored checks (case-insensitive) and skips broken ignore patterns", () => {
    const c = toView(rawPr({}, contexts), 1, { ...OPTS, ignoredChecks: ["^A-", "("] }).checks;
    assert.equal(c.items.some((i) => i.name === "a-fail"), false);
    assert.equal(c.total, 9);
  });

  test("lists the workflow runs that can be re-run", () => {
    const r = toView(rawPr({}, contexts), 1, OPTS).rerun;
    assert.deepEqual(r, { failedRunIds: [11], allRunIds: [11, 12, 10], failedExternal: 2 });
  });

  test("a PR without a status rollup has no checks", () => {
    const v = toView(rawPr({ commits: { nodes: [] } }), 1, OPTS);
    assert.equal(v.checks.total, 0);
  });
});

describe("toView: review threads", () => {
  const thread = (isResolved: boolean, login: string, extra: object = {}) => ({
    isResolved,
    comments: { nodes: [{ author: { __typename: login.endsWith("[bot]") ? "Bot" : "User", login }, bodyText: "  hi\n there ", url: "https://t" }] },
    ...extra,
  });

  test("counts resolved threads and lists the open ones", () => {
    const pr = rawPr({
      reviewThreads: {
        totalCount: 3,
        nodes: [
          thread(true, "ann"),
          thread(false, "bob", { path: "a.ts", line: 3, isOutdated: true }),
          thread(false, "cid", { path: "b.ts" }),
        ],
      },
    });
    const t = toView(pr, 1, OPTS).threads;
    assert.equal(t.resolved, 1);
    assert.equal(t.total, 3);
    assert.deepEqual(t.items[0], { author: "bob", where: "a.ts:3", snippet: "hi there", url: "https://t", outdated: true });
    assert.equal(t.items[1].where, "b.ts");
  });

  test("cuts long comments and leaves bot threads out when asked", () => {
    const long = { isResolved: false, comments: { nodes: [{ author: null, bodyText: "x".repeat(200) }] } };
    const pr = rawPr({ reviewThreads: { totalCount: 3, nodes: [long, thread(false, "dep[bot]"), thread(false, "Copilot")] } });
    const all = toView(pr, 1, OPTS).threads;
    assert.equal(all.items[0].author, "ghost");
    assert.equal(all.items[0].snippet.length, 120);
    assert.ok(all.items[0].snippet.endsWith("…"));
    assert.equal(toView(pr, 1, { ...OPTS, ignoreBotThreads: true }).threads.total, 1);
  });
});

describe("toView: approvals", () => {
  const review = (state: string, login: string) => ({ state, url: `https://r/${login}`, author: { __typename: "User", login } });

  test("lists changes requested, then still to review, then approved", () => {
    const pr = rawPr({
      latestOpinionatedReviews: { nodes: [review("APPROVED", "ann"), review("CHANGES_REQUESTED", "bob"), review("COMMENTED", "x")] },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "Team", name: "core" } },
          { requestedReviewer: { __typename: "User", login: "cid" } },
          { requestedReviewer: null },
        ],
      },
    });
    const a = toView(pr, 2, OPTS).approvals;
    assert.equal(a.approved, 1);
    assert.equal(a.required, 2);
    assert.equal(a.changesRequested, 1);
    assert.deepEqual(
      a.items.map((i) => `${i.state}:${i.name}`),
      ["changes:bob", "requested:team core", "requested:cid", "approved:ann"],
    );
  });
});

describe("toView: status", () => {
  const ok = [run("ci", "COMPLETED", "SUCCESS")];
  const approved = { latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { __typename: "User", login: "a" } }] } };

  test("draft wins over everything", () => {
    assert.equal(toView(rawPr({ isDraft: true }, [run("x", "COMPLETED", "FAILURE")]), 1, OPTS).status, "draft");
  });

  test("failing, then changes requested, then running", () => {
    assert.equal(toView(rawPr({ reviewDecision: "CHANGES_REQUESTED" }, [run("x", "COMPLETED", "FAILURE")]), 1, OPTS).status, "failing");
    assert.equal(toView(rawPr({ reviewDecision: "CHANGES_REQUESTED" }, [run("x", "QUEUED")]), 1, OPTS).status, "changes");
    assert.equal(toView(rawPr({}, [run("x", "QUEUED")]), 1, OPTS).status, "running");
  });

  test("ready needs approvals, resolved threads and no conflicts", () => {
    assert.equal(toView(rawPr(approved, ok), 1, OPTS).status, "ready");
    assert.equal(toView(rawPr(approved, ok), 2, OPTS).status, "waiting");
    assert.equal(toView(rawPr({ ...approved, mergeable: "CONFLICTING" }, ok), 1, OPTS).status, "waiting");
  });

  test("copies the PR facts the panel shows", () => {
    const v = toView(rawPr({ isInMergeQueue: true, viewerCanUpdateBranch: true, headRefOid: "abc", author: null }), 0, OPTS);
    assert.equal(v.inMergeQueue, true);
    assert.equal(v.canUpdateBranch, true);
    assert.equal(v.headOid, "abc");
    assert.equal(v.author, "ghost");
    assert.equal(v.baseRef, "main");
  });
});
