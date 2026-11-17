import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { parsePrRef, ticketKeyIn, ticketsOf } from "../src/ticketLinks";

describe("parsePrRef", () => {
  test("PR links and owner/repo#n", () => {
    assert.deepEqual(parsePrRef(" https://github.com/o/r/pull/12/files "), { repo: "o/r", number: 12 });
    assert.deepEqual(parsePrRef("o/r.x#7"), { repo: "o/r.x", number: 7 });
  });

  test("bare numbers need a default repo", () => {
    assert.deepEqual(parsePrRef("#5", "o/r"), { repo: "o/r", number: 5 });
    assert.deepEqual(parsePrRef("5", "o/r"), { repo: "o/r", number: 5 });
    assert.equal(parsePrRef("5"), undefined);
    assert.equal(parsePrRef("ABC-1", "o/r"), undefined);
  });
});

describe("ticketsOf", () => {
  const pattern = "[A-Za-z][A-Za-z0-9]+-\\d+";

  test("every key from the branch, then the title, upper-cased and de-duplicated", () => {
    assert.deepEqual(ticketsOf({ headRefName: "abc-1-and-DEF-2", title: "ABC-1 GHI-3" }, pattern), ["ABC-1", "DEF-2", "GHI-3"]);
  });

  test("a broken pattern finds nothing", () => {
    assert.deepEqual(ticketsOf({ headRefName: "ABC-1", title: "" }, "("), []);
  });
});

describe("ticketKeyIn", () => {
  test("first key in text or a Jira link", () => {
    assert.equal(ticketKeyIn("see https://j/browse/abc-12?x"), "ABC-12");
    assert.equal(ticketKeyIn("nothing here"), undefined);
  });
});
