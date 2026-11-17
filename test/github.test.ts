import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { apiTargetFor, graphql, rest, restPost, searchPrs } from "../src/core/github";
import { stubFetch } from "./fakes";

const API = apiTargetFor(undefined, "tok");
let restore = () => undefined as void;
afterEach(() => restore());

describe("apiTargetFor", () => {
  test("github.com by default, the Enterprise server's API otherwise", () => {
    assert.deepEqual(API, { restBase: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql", token: "tok" });
    assert.deepEqual(apiTargetFor("https://ghe.io/some/path", "t"), { restBase: "https://ghe.io/api/v3", graphqlUrl: "https://ghe.io/api/graphql", token: "t" });
    assert.throws(() => apiTargetFor("http://ghe.io", "t"), /must use https/);
  });
});

describe("graphql", () => {
  test("posts the query with the token and returns the data", async () => {
    const s = stubFetch(() => ({ json: { data: { x: 1 } } }));
    restore = s.restore;
    assert.deepEqual(await graphql(API, "{ x }", { a: 1 }), { x: 1 });
    assert.equal(s.calls[0].url, "https://api.github.com/graphql");
    assert.equal(s.calls[0].method, "POST");
    assert.equal(s.calls[0].headers.Authorization, "Bearer tok");
    assert.deepEqual(s.calls[0].body, { query: "{ x }", variables: { a: 1 } });
  });

  test("HTTP errors, errors without data, and strict mode throw", async () => {
    restore = stubFetch(() => ({ status: 502, text: "bad gateway" })).restore;
    await assert.rejects(graphql(API, "q", {}), /GitHub GraphQL 502: bad gateway/);
    restore();
    restore = stubFetch(() => ({ json: { errors: [{ message: "a" }, { message: "b" }] } })).restore;
    await assert.rejects(graphql(API, "q", {}), /a; b/);
    restore();
    restore = stubFetch(() => ({ json: { data: { x: 1 }, errors: [{ message: "partial" }] } })).restore;
    assert.deepEqual(await graphql(API, "q", {}), { x: 1 });
    await assert.rejects(graphql(API, "q", {}, true), /partial/);
  });
});

describe("REST", () => {
  test("rest reads JSON, undefined on an error status", async () => {
    const s = stubFetch((c) => (c.url.endsWith("/ok") ? { json: [1] } : { status: 404, json: {} }));
    restore = s.restore;
    assert.deepEqual(await rest(API, "/ok"), [1]);
    assert.equal(await rest(API, "/missing"), undefined);
    assert.equal(s.calls[0].headers.Accept, "application/vnd.github+json");
  });

  test("restPost throws GitHub's message, or the status", async () => {
    restore = stubFetch(() => ({ status: 201, json: {} })).restore;
    await restPost(API, "/x");
    restore();
    restore = stubFetch(() => ({ status: 403, json: { message: "nope" } })).restore;
    await assert.rejects(restPost(API, "/x"), /^Error: nope$/);
    restore();
    restore = stubFetch(() => ({ status: 500, text: "<html>" })).restore;
    await assert.rejects(restPost(API, "/x"), /500/);
  });
});

describe("searchPrs", () => {
  test("pages until done or the page limit, skipping non-PR nodes", async () => {
    let page = 0;
    const s = stubFetch(() => {
      page++;
      return { json: { data: { search: { pageInfo: { hasNextPage: true, endCursor: `c${page}` }, nodes: [{ id: `p${page}` }, {}] } } } };
    });
    restore = s.restore;
    assert.deepEqual(await searchPrs(API, "id", "is:pr", 2), [{ id: "p1" }, { id: "p2" }]);
    assert.deepEqual((s.calls[1].body as { variables: unknown }).variables, { q: "is:pr", cursor: "c1" });
  });

  test("stops when there is no next page", async () => {
    const s = stubFetch(() => ({ json: { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "a" }] } } } }));
    restore = s.restore;
    assert.deepEqual(await searchPrs(API, "id", "q", 4), [{ id: "a" }]);
    assert.equal(s.calls.length, 1);
  });
});
