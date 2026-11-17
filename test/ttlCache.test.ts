import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { TtlCache } from "../src/ttlCache";

describe("TtlCache", () => {
  test("loads once within the TTL, again after it", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<number>(100, () => now);
    const load = async () => ++loads;
    assert.equal(await cache.get("k", load), 1);
    now = 99;
    assert.equal(await cache.get("k", load), 1);
    now = 100;
    assert.equal(await cache.get("k", load), 2);
  });

  test("peek returns stale values; set stores without loading", async () => {
    let now = 0;
    const cache = new TtlCache<string>(10, () => now);
    assert.equal(cache.peek("k"), undefined);
    cache.set("k", "v");
    now = 1000;
    assert.equal(cache.peek("k"), "v");
    await assert.rejects(cache.get("k", () => Promise.reject(new Error("down"))), /down/);
    assert.equal(cache.peek("k"), "v");
  });

  test("uses the real clock by default", async () => {
    const cache = new TtlCache<number>(60_000);
    assert.equal(await cache.get("k", async () => 1), 1);
    assert.equal(await cache.get("k", async () => 2), 1);
  });
});
