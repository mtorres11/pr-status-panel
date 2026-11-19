import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { COPY_GROUPS, copyText, inGroup } from "../src/core/copy";
import { view } from "./helpers";

describe("inGroup", () => {
  const cases: [string, Parameters<typeof view>[0], string[]][] = [
    ["needs approval", { approvals: { approved: 0, required: 1, changesRequested: 0, items: [], pendingOwnerTeams: [] }, status: "waiting" }, ["approval", "waiting", "all"]],
    ["queued", { inMergeQueue: true, approvals: { approved: 0, required: 1, changesRequested: 0, items: [], pendingOwnerTeams: [] } }, ["ready", "queued", "all"]],
    ["behind", { canUpdateBranch: true }, ["ready", "behind", "all"]],
    ["behind draft", { canUpdateBranch: true, isDraft: true, status: "draft" }, ["drafts", "all"]],
    ["failing", { status: "failing" }, ["failing", "all"]],
    ["changes", { status: "changes" }, ["changes", "all"]],
    ["running", { status: "running" }, ["running", "all"]],
  ];
  for (const [name, over, groups] of cases) {
    test(name, () => {
      const p = view(over);
      assert.deepEqual(COPY_GROUPS.filter((g) => inGroup(p, g)), groups);
    });
  }
});

describe("copyText", () => {
  const a = view({ title: "Fix  the\nthing [x]", ticket: "AB-1", ticketUrl: "https://j/browse/AB-1" });
  const b = view({ id: "2", number: 2, url: "https://github.com/o/r/pull/2", title: "chore: bump", ticket: "AB-2", status: "failing" });
  const c = view({ id: "3", number: 3, url: "https://github.com/o/r/pull/3", title: "No key", status: "failing" });

  test("links: one URL per line", () => {
    assert.equal(copyText([a, b], "links", false), `${a.url}\n${b.url}`);
  });

  test("markdown: ticket link, escaped title; chores carry no ticket", () => {
    assert.equal(
      copyText([a, b, c], "markdown", false),
      [
        "- [AB-1](https://j/browse/AB-1) [Fix the thing \\[x\\]](https://github.com/o/r/pull/1)",
        "- [chore: bump](https://github.com/o/r/pull/2)",
        "- [No key](https://github.com/o/r/pull/3)",
      ].join("\n"),
    );
    const noUrl = view({ ticket: "AB-3" });
    assert.equal(copyText([noUrl], "markdown", false), "- AB-3 [Add a thing](https://github.com/o/r/pull/1)");
  });

  test("ticket: key and title, Jira link, PR link; blank line between PRs", () => {
    assert.equal(
      copyText([a, c], "ticket", false),
      "AB-1 · Fix the thing [x]\nJira: https://j/browse/AB-1\nPR: https://github.com/o/r/pull/1\n\nNo key\nPR: https://github.com/o/r/pull/3",
    );
  });

  test("grouped: one titled section per status, in list order", () => {
    assert.equal(
      copyText([a, b, c], "links", true),
      `Checks failing (2)\n${b.url}\n${c.url}\n\nReady to merge (1)\n${a.url}`,
    );
    assert.equal(copyText([b], "markdown", true), `**Checks failing (1)**\n- [chore: bump](${b.url})`);
  });
});
