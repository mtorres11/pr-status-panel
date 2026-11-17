import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mapLimit } from "../src/core/async";

test("mapLimit keeps order and never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 10, 20, 0, 5], 2, async (ms) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 0, 10]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 3, async (x) => x), []);
});
