import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { apiTargetFor } from "../src/core/github";
import { gitHubPrClient } from "../src/core/githubPrs";
import { FetchCall, stubFetch } from "./fakes";

const API = apiTargetFor(undefined, "tok");
let restore = () => undefined as void;
afterEach(() => restore());

const page = (nodes: unknown[], hasNextPage = false) => ({ json: { data: { search: { pageInfo: { hasNextPage, endCursor: "c" }, nodes } } } });
const query = (c: FetchCall) => (c.body as { query: string }).query;

describe("gitHubPrClient", () => {
  test("search asks for viewerCanUpdateBranch, and drops it for good once a server rejects it", async () => {
    const s = stubFetch((c) =>
      query(c).includes("viewerCanUpdateBranch")
        ? { json: { errors: [{ message: "Field 'viewerCanUpdateBranch' doesn't exist" }] } }
        : page([{ id: "a" }]),
    );
    restore = s.restore;
    const client = gitHubPrClient();
    assert.deepEqual(await client.search(API, "q"), [{ id: "a" }]);
    assert.deepEqual(await client.search(API, "q"), [{ id: "a" }]);
    assert.equal(s.calls.length, 3);
    assert.ok(!query(s.calls[2]).includes("viewerCanUpdateBranch"));
  });

  test("other search errors are not swallowed", async () => {
    restore = stubFetch(() => ({ json: { errors: [{ message: "rate limited" }] } })).restore;
    await assert.rejects(gitHubPrClient().search(API, "q"), /rate limited/);
  });

  test("viewer login and repos (archived ones left out, paged)", async () => {
    let call = 0;
    restore = stubFetch((c) => {
      if (query(c).includes("viewer { login }")) return { json: { data: { viewer: { login: "me" } } } };
      call++;
      const nodes = [{ nameWithOwner: `o/r${call}`, isArchived: false }, { nameWithOwner: "o/old", isArchived: true }];
      return { json: { data: { viewer: { repositories: { pageInfo: { hasNextPage: call < 2, endCursor: "c" }, nodes } } } } };
    }).restore;
    const client = gitHubPrClient();
    assert.equal(await client.viewerLogin(API), "me");
    assert.deepEqual(await client.repos(API), ["o/r1", "o/r2"]);
  });

  test("required approvals: the largest pull_request rule; undefined without one or on failure", async () => {
    restore = stubFetch((c) =>
      c.url.includes("/rules/branches/main")
        ? { json: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "pull_request", parameters: { required_approving_review_count: 2 } }, { type: "pull_request" }, { type: "deletion" }] }
        : c.url.includes("/rules/branches/dev")
          ? { json: [{ type: "deletion" }] }
          : { status: 404, json: {} },
    ).restore;
    const client = gitHubPrClient();
    assert.equal(await client.requiredApprovals(API, "o/r", "main"), 2);
    assert.equal(await client.requiredApprovals(API, "o/r", "dev"), undefined);
    assert.equal(await client.requiredApprovals(API, "o/r", "x"), undefined);
    restore();
    restore = stubFetch(() => {
      throw new Error("offline");
    }).restore;
    assert.equal(await client.requiredApprovals(API, "o/r", "main"), undefined);
  });

  test("re-run posts to the failed-jobs or full re-run endpoint", async () => {
    const s = stubFetch(() => ({ status: 201, json: {} }));
    restore = s.restore;
    const client = gitHubPrClient();
    await client.rerun(API, "o/r", 7, true);
    await client.rerun(API, "o/r", 8, false);
    assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), [
      "POST https://api.github.com/repos/o/r/actions/runs/7/rerun-failed-jobs",
      "POST https://api.github.com/repos/o/r/actions/runs/8/rerun",
    ]);
  });

  test("update branch sends the expected head and fails on any GraphQL error", async () => {
    const s = stubFetch(() => ({ json: { data: { updatePullRequestBranch: {} } } }));
    restore = s.restore;
    await gitHubPrClient().updateBranch(API, "PR_1", undefined, "REBASE");
    assert.deepEqual((s.calls[0].body as { variables: unknown }).variables, { id: "PR_1", head: null, method: "REBASE" });
    restore();
    restore = stubFetch(() => ({ json: { data: {}, errors: [{ message: "expected head sha" }] } })).restore;
    await assert.rejects(gitHubPrClient().updateBranch(API, "PR_1", "abc", "MERGE"), /expected head sha/);
  });
});
