import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_UI, storedUi, validPatch } from "../src/uiState";

describe("validPatch", () => {
  test("keeps valid PR and Deployments keys", () => {
    const all = { author: "@other", repo: "o/r", show: "review", sort: "ticket", drafts: false, copyGroup: "ready", copyFormat: "markdown", tab: "deploy" };
    assert.deepEqual(validPatch(all, []), all);
  });

  test("drops invalid values and unknown accounts", () => {
    assert.deepEqual(validPatch({ author: "bad name", repo: "x", show: "x", drafts: "yes", accountKey: "github:9" }, ["github:1"]), {});
    assert.deepEqual(validPatch({ accountKey: "github:1" }, ["github:1"]), { accountKey: "github:1" });
    assert.deepEqual(validPatch("junk", []), {});
  });
});

describe("storedUi", () => {
  test("defaults for an empty store", () => {
    assert.deepEqual(storedUi(undefined), DEFAULT_UI);
  });

  test("keeps the stored account key and never the @other placeholder", () => {
    const ui = storedUi({ accountKey: "github:7", author: "@other", repo: "o/r" });
    assert.equal(ui.accountKey, "github:7");
    assert.equal(ui.author, "@me");
    assert.equal(ui.repo, "o/r");
  });

  test("migrates the old 'Add description' checkbox to the ticket format", () => {
    assert.equal(storedUi({ addDescription: true }).copyFormat, "ticket");
    assert.equal(storedUi({ addDescription: true, copyFormat: "markdown" }).copyFormat, "markdown");
  });
});
