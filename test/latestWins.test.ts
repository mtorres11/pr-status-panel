import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { LatestWins } from "../src/latestWins";

/** A promise with its resolve function, to finish tasks in a chosen order. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("LatestWins", () => {
  test("only the newest run applies; loading ends with it", async () => {
    let changes = 0;
    const lw = new LatestWins(() => changes++);
    const applied: string[] = [];
    const first = deferred();
    const a = lw.run(true, async (isCurrent) => {
      await first.promise;
      if (isCurrent()) applied.push("first");
    }, () => undefined);
    assert.equal(lw.loading, true);
    const b = lw.run(true, async (isCurrent) => {
      if (isCurrent()) applied.push("second");
    }, () => undefined);
    await b;
    first.resolve();
    await a;
    assert.deepEqual(applied, ["second"]);
    assert.equal(lw.loading, false);
    assert.equal(changes, 3);
  });

  test("a run without force is skipped while another is loading", async () => {
    const lw = new LatestWins(() => undefined);
    const gate = deferred();
    let runs = 0;
    const a = lw.run(false, async () => {
      runs++;
      await gate.promise;
    }, () => undefined);
    await lw.run(false, async () => void runs++, () => undefined);
    gate.resolve();
    await a;
    assert.equal(runs, 1);
  });

  test("errors reach fail only from the newest run", async () => {
    const lw = new LatestWins(() => undefined);
    const errors: string[] = [];
    const gate = deferred();
    const old = lw.run(true, async () => {
      await gate.promise;
      throw new Error("old");
    }, (e) => errors.push(e.message));
    await lw.run(true, async () => {
      throw new Error("new");
    }, (e) => errors.push(e.message));
    gate.resolve();
    await old;
    assert.deepEqual(errors, ["new"]);
  });
});
