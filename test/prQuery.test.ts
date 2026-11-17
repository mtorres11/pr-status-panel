import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { prQueries } from "../src/core/prQuery";
import { DEFAULT_UI } from "../src/core/uiState";

const CTX = { viewer: "me", teamMembers: ["ann", "bob"], organizations: ["acme", "labs"] };

describe("prQueries", () => {
  test("my authored PRs in the organizations, drafts included", () => {
    assert.deepEqual(prQueries(DEFAULT_UI, CTX), ["is:pr is:open archived:false org:acme org:labs author:me"]);
  });

  test("one repo, no drafts, every role for every team member", () => {
    const qs = prQueries({ ...DEFAULT_UI, author: "@team", repo: "o/r", drafts: false, show: "all" }, CTX);
    assert.equal(qs.length, 6);
    assert.equal(qs[0], "is:pr is:open archived:false draft:false repo:o/r author:ann");
    assert.equal(qs[5], "is:pr is:open archived:false draft:false repo:o/r assignee:bob");
  });

  test("one login, review requested, everywhere", () => {
    const qs = prQueries({ ...DEFAULT_UI, author: "zed", show: "review" }, { ...CTX, organizations: [] });
    assert.deepEqual(qs, ["is:pr is:open archived:false review-requested:zed"]);
    assert.deepEqual(prQueries({ ...DEFAULT_UI, show: "assigned" }, { ...CTX, organizations: [] }), [
      "is:pr is:open archived:false assignee:me",
    ]);
  });
});
