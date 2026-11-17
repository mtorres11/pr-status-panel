import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { jiraOrigin, parsePrRef, ticketKeyIn, ticketsOf, ticketUrl } from "../src/core/ticketLinks";

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

  test("a broken pattern finds nothing; empty matches are skipped", () => {
    assert.deepEqual(ticketsOf({ headRefName: "ABC-1", title: "" }, "("), []);
    assert.deepEqual(ticketsOf({ headRefName: "ABC-1", title: "" }, "x*"), []);
  });
});

describe("ticketKeyIn", () => {
  test("first key in text or a Jira link", () => {
    assert.equal(ticketKeyIn("see https://j/browse/abc-12?x"), "ABC-12");
    assert.equal(ticketKeyIn("nothing here"), undefined);
  });
});

describe("jiraOrigin", () => {
  test("keeps only the site of any Jira link", () => {
    assert.equal(jiraOrigin(" https://x.atlassian.net/browse/A-1 "), "https://x.atlassian.net");
    assert.equal(jiraOrigin("x.atlassian.net"), "https://x.atlassian.net");
    assert.equal(jiraOrigin("http://jira.local/a"), "http://jira.local");
  });

  test("rejects empty and non-URL values", () => {
    assert.equal(jiraOrigin(""), "");
    assert.equal(jiraOrigin("https://"), "");
  });
});

describe("ticketUrl", () => {
  test("a browse link on the Jira site", () => {
    assert.equal(ticketUrl("https://j.io/jira/boards/2", "AB-1"), "https://j.io/browse/AB-1");
    assert.equal(ticketUrl("", "AB-1"), undefined);
    assert.equal(ticketUrl("https://j.io", undefined), undefined);
  });
});
