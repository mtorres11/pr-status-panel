import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { MessageHandlers, parseMessage, routeMessage, WebviewMessage } from "../src/core/protocol";

describe("parseMessage", () => {
  test("drops unknown types and non-objects", () => {
    assert.equal(parseMessage({ type: "nope" }), undefined);
    assert.equal(parseMessage({ type: "toString" }), undefined);
    assert.equal(parseMessage("ready"), undefined);
    assert.equal(parseMessage(null), undefined);
    assert.deepEqual(parseMessage({ type: "ready", extra: 1 }), { type: "ready" });
  });

  test("copyLinks keeps string ids and falls back to the default group and format", () => {
    assert.deepEqual(parseMessage({ type: "copyLinks", ids: ["a", 1, "b"], group: "x", format: "y" }), {
      type: "copyLinks",
      ids: ["a", "b"],
      group: "approval",
      format: "links",
    });
    assert.deepEqual(parseMessage({ type: "copyLinks", ids: "a", group: "ready", format: "markdown" }), {
      type: "copyLinks",
      ids: [],
      group: "ready",
      format: "markdown",
    });
  });

  test("actions on a PR", () => {
    assert.deepEqual(parseMessage({ type: "rerun", prId: "P", mode: "failed" }), { type: "rerun", prId: "P", failedOnly: true });
    assert.deepEqual(parseMessage({ type: "rerun", prId: 3 }), { type: "rerun", prId: "", failedOnly: false });
    assert.deepEqual(parseMessage({ type: "updateBranch", prId: "P", method: "rebase" }), { type: "updateBranch", prId: "P", method: "REBASE" });
    assert.deepEqual(parseMessage({ type: "updateBranch", prId: "P" }), { type: "updateBranch", prId: "P", method: "MERGE" });
    assert.deepEqual(parseMessage({ type: "copyUrl", prId: "P", which: "ticket" }), { type: "copyUrl", prId: "P", which: "ticket" });
    assert.deepEqual(parseMessage({ type: "copyUrl", prId: "P", which: "x" }), { type: "copyUrl", prId: "P", which: "pr" });
    assert.deepEqual(parseMessage({ type: "configureJira", ticket: "AB-1" }), { type: "configureJira", ticket: "AB-1" });
  });

  test("links must be https and repos valid", () => {
    assert.deepEqual(parseMessage({ type: "open", url: "https://x.io" }), { type: "open", url: "https://x.io" });
    assert.equal(parseMessage({ type: "open", url: "file:///etc/hosts" }), undefined);
    assert.deepEqual(parseMessage({ type: "toggleFavorite", repo: "o/r" }), { type: "toggleFavorite", repo: "o/r" });
    assert.equal(parseMessage({ type: "toggleFavorite", repo: "../x" }), undefined);
  });

  test("setState always carries an object patch", () => {
    assert.deepEqual(parseMessage({ type: "setState", patch: [1] }), { type: "setState", patch: {} });
    assert.deepEqual(parseMessage({ type: "setState", patch: { sort: "x" } }), { type: "setState", patch: { sort: "x" } });
  });

  test("the plain commands", () => {
    for (const type of ["refresh", "addAccount", "signIn", "openSettings", "awsProfile", "awsSignIn"])
      assert.deepEqual(parseMessage({ type }), { type });
  });
});

describe("routeMessage", () => {
  test("calls the handler of a valid message only", async () => {
    const seen: WebviewMessage[] = [];
    const handlers = new Proxy({}, { get: () => (m: WebviewMessage) => seen.push(m) }) as MessageHandlers;
    await routeMessage(handlers, { type: "refresh" });
    await routeMessage(handlers, { type: "open", url: "http://x" });
    assert.deepEqual(seen, [{ type: "refresh" }]);
  });
});
