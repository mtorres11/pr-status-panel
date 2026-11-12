// Thin GitHub API client: GraphQL for PR data, REST for branch rules and re-runs.
// The token is only ever sent to api.github.com or to the https GitHub Enterprise
// host the user configured in VS Code's own "github-enterprise.uri" user setting.

import { repoPath } from "./validate";

/** Every request is abandoned after this long. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface ApiTarget {
  /** e.g. https://api.github.com or https://ghe.example.com/api */
  restBase: string;
  graphqlUrl: string;
  token: string;
}

export function apiTargetFor(
  enterpriseUri: string | undefined,
  token: string,
): ApiTarget {
  if (enterpriseUri) {
    const u = new URL(enterpriseUri);
    if (u.protocol !== "https:") {
      throw new Error("GitHub Enterprise URL must use https://");
    }
    return {
      restBase: `${u.origin}/api/v3`,
      graphqlUrl: `${u.origin}/api/graphql`,
      token,
    };
  }
  return {
    restBase: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    token,
  };
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

async function graphql<T>(
  api: ApiTarget,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(api.graphqlUrl, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: "POST",
    headers: {
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
      "User-Agent": "pr-status-panel",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new GitHubError(
      `GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`,
      res.status,
    );
  }
  const body = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors?.length && !body.data) {
    throw new GitHubError(body.errors.map((e) => e.message).join("; "));
  }
  return body.data as T;
}

// ---------- Raw GraphQL shapes ----------

interface RawActor {
  __typename: string;
  login: string;
}

interface RawCheckContext {
  __typename: "CheckRun" | "StatusContext";
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun: { databaseId: number } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

export interface RawPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  isInMergeQueue?: boolean;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  mergeable: string;
  repository: { nameWithOwner: string };
  author: RawActor | null;
  baseRef: {
    branchProtectionRule: {
      requiredApprovingReviewCount: number | null;
    } | null;
  } | null;
  latestOpinionatedReviews: {
    nodes: { state: string; author: RawActor | null }[];
  };
  reviewThreads: {
    totalCount: number;
    nodes: {
      isResolved: boolean;
      comments: { nodes: { author: RawActor | null }[] };
    }[];
  };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: RawCheckContext[] };
        } | null;
      };
    }[];
  };
}

const PR_FIELDS = `
  ... on PullRequest {
    id number title url isDraft isInMergeQueue updatedAt headRefName baseRefName reviewDecision mergeable
    repository { nameWithOwner }
    author { __typename login }
    baseRef { branchProtectionRule { requiredApprovingReviewCount } }
    latestOpinionatedReviews(first: 30, writersOnly: true) { nodes { state author { __typename login } } }
    reviewThreads(first: 100) {
      totalCount
      nodes { isResolved comments(first: 1) { nodes { author { __typename login } } } }
    }
    commits(last: 1) {
      nodes { commit { statusCheckRollup {
        state
        contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
          ... on StatusContext { context state targetUrl }
        } }
      } } }
    }
  }`;

const SEARCH_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PR_FIELDS} }
  }
}`;

export async function searchPullRequests(
  api: ApiTarget,
  q: string,
  maxPages = 4,
): Promise<RawPullRequest[]> {
  const out: RawPullRequest[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: {
      search: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: (RawPullRequest | Record<string, never>)[];
      };
    } = await graphql(api, SEARCH_QUERY, { q, cursor });
    for (const n of data.search.nodes) {
      if (n && "id" in n) out.push(n as RawPullRequest);
    }
    if (!data.search.pageInfo.hasNextPage) break;
    cursor = data.search.pageInfo.endCursor;
  }
  return out;
}

export async function getViewerLogin(api: ApiTarget): Promise<string> {
  const data = await graphql<{ viewer: { login: string } }>(
    api,
    "{ viewer { login } }",
    {},
  );
  return data.viewer.login;
}

const REPOS_QUERY = `
query($cursor: String) {
  viewer {
    repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                 ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                 orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner isArchived }
    }
  }
}`;

/** Repos the account can access, most recently pushed first (capped). */
export async function listViewerRepos(
  api: ApiTarget,
  cap = 1000,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  while (out.length < cap) {
    const data: {
      viewer: {
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { nameWithOwner: string; isArchived: boolean }[];
        };
      };
    } = await graphql(api, REPOS_QUERY, { cursor });
    const r = data.viewer.repositories;
    for (const n of r.nodes) if (!n.isArchived) out.push(n.nameWithOwner);
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
}

/**
 * Required approving reviews for a branch, read from repository rulesets
 * (readable with plain read access). Returns undefined when no rule applies
 * or the call fails.
 */
export async function getRulesetRequiredApprovals(
  api: ApiTarget,
  repo: string,
  branch: string,
): Promise<number | undefined> {
  try {
    const res = await fetch(
      `${api.restBase}/repos/${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}`,
      {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${api.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "pr-status-panel",
        },
      },
    );
    if (!res.ok) return undefined;
    const rules = (await res.json()) as {
      type: string;
      parameters?: { required_approving_review_count?: number };
    }[];
    const counts = rules
      .filter((r) => r.type === "pull_request")
      .map((r) => r.parameters?.required_approving_review_count ?? 0);
    return counts.length ? Math.max(...counts) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-runs a GitHub Actions workflow run: only its failed jobs, or all jobs.
 * Throws a GitHubError with GitHub's message on failure (e.g. run still in progress).
 */
export async function rerunWorkflowRun(
  api: ApiTarget,
  repo: string,
  runId: number,
  failedOnly: boolean,
): Promise<void> {
  const path = failedOnly ? "rerun-failed-jobs" : "rerun";
  const res = await fetch(
    `${api.restBase}/repos/${repoPath(repo)}/actions/runs/${encodeURIComponent(String(runId))}/${path}`,
    {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pr-status-panel",
      },
    },
  );
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      /* keep status code */
    }
    throw new GitHubError(message, res.status);
  }
}
