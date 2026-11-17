import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { isHttpsUrl, isLogin, isRepo, logins, repoPath, repos } from "../src/validate";

describe("validate", () => {
  test("isLogin", () => {
    assert.equal(isLogin("octo-cat"), true);
    assert.equal(isLogin("-bad"), false);
    assert.equal(isLogin("a".repeat(40)), false);
    assert.equal(isLogin(3), false);
  });

  test("isRepo", () => {
    assert.equal(isRepo("o/r.js"), true);
    assert.equal(isRepo("o/.."), false);
    assert.equal(isRepo("o/."), false);
    assert.equal(isRepo("o"), false);
    assert.equal(isRepo(null), false);
  });

  test("logins and repos keep only valid entries", () => {
    assert.deepEqual(logins(["ok", "bad one", 1]), ["ok"]);
    assert.deepEqual(logins("ok"), []);
    assert.deepEqual(repos(["o/r", "nope"]), ["o/r"]);
    assert.deepEqual(repos(undefined), []);
  });

  test("isHttpsUrl", () => {
    assert.equal(isHttpsUrl("https://x.io/a"), true);
    assert.equal(isHttpsUrl("http://x.io"), false);
    assert.equal(isHttpsUrl("javascript:alert(1)"), false);
    assert.equal(isHttpsUrl("not a url"), false);
    assert.equal(isHttpsUrl(1), false);
  });

  test("repoPath encodes each part", () => {
    assert.equal(repoPath("o/r#1"), "o/r%231");
  });
});
