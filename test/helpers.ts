// Builders for test data: a raw GitHub PR and a PR view with sensible defaults.

import type { DeployRawPr } from "../src/deployGithub";
import type { RawPullRequest } from "../src/githubPrs";
import type { PrView } from "../src/model";

type Rollup = NonNullable<RawPullRequest["commits"]["nodes"][number]["commit"]["statusCheckRollup"]>;
type Context = Rollup["contexts"]["nodes"][number];

/** A raw PR with no checks, reviews or threads, overridable field by field. */
export function rawPr(over: Partial<RawPullRequest> = {}, contexts: Context[] = []): RawPullRequest {
  return {
    id: "PR_1",
    number: 1,
    title: "Add a thing",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00Z",
    headRefName: "feature",
    baseRefName: "main",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    repository: { nameWithOwner: "o/r" },
    author: { __typename: "User", login: "me" },
    baseRef: null,
    latestOpinionatedReviews: { nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: contexts } } } }] },
    ...over,
  };
}

/** A check run context. */
export function run(name: string, status: string, conclusion: string | null = null, runId?: number): Context {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: `https://ci/${name}`,
    checkSuite: runId === undefined ? null : { workflowRun: { databaseId: runId } },
  };
}

/** A commit status context. */
export function status(context: string, state: string): Context {
  return { __typename: "StatusContext", context, state, targetUrl: null };
}

/** A PR view with everything passing and nothing pending. */
export function view(over: Partial<PrView> = {}): PrView {
  return {
    id: "PR_1",
    repo: "o/r",
    number: 1,
    title: "Add a thing",
    url: "https://github.com/o/r/pull/1",
    author: "me",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    inMergeQueue: false,
    status: "ready",
    checks: { passed: 0, failed: 0, running: 0, pending: 0, skipped: 0, total: 0, items: [] },
    threads: { resolved: 0, total: 0, items: [] },
    approvals: { approved: 1, required: 1, changesRequested: 0, items: [] },
    mergeable: "MERGEABLE",
    baseRef: "main",
    canUpdateBranch: false,
    rerun: { failedRunIds: [], allRunIds: [], failedExternal: 0 },
    ...over,
  };
}

/** A Deployments search result. */
export function deployRaw(over: Partial<DeployRawPr> = {}): DeployRawPr {
  return {
    id: "D1",
    number: 5,
    title: "ABC-1 Add thing",
    url: "https://github.com/o/r/pull/5",
    isDraft: false,
    state: "MERGED",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
    mergedAt: "2026-03-02T00:00:00Z",
    mergeCommit: { oid: "m".repeat(40) },
    headRefName: "feature",
    headRefOid: "h".repeat(40),
    baseRefName: "main",
    reviewDecision: null,
    repository: { nameWithOwner: "o/r" },
    author: { login: "me" },
    mergedBy: { login: "ann" },
    ...over,
  };
}
