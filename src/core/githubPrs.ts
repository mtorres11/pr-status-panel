// The PR tab's GitHub calls: search PRs with everything a card shows, the viewer and their repos, required
// approvals from branch rules, re-running Actions workflows and updating a branch.

import { ApiTarget, graphql, rest, restPost, searchPrs } from "./github";
import { repoPath } from "./validate";

interface RawActor {
  __typename: string;
  login: string;
}

export interface RawCheckContext {
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
  /** Head commit; passed back when updating the branch so a newer push is never overwritten. */
  headRefOid?: string;
  /** True when the branch is behind its base and the viewer may update it. */
  viewerCanUpdateBranch?: boolean;
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
    nodes: { state: string; url?: string | null; author: RawActor | null }[];
  };
  /** Reviewers (users or teams) asked to review who have not reviewed yet. */
  reviewRequests?: {
    nodes: {
      requestedReviewer:
        | { __typename: "User" | "Mannequin" | "Bot"; login: string }
        | { __typename: "Team"; name: string }
        | null;
    }[];
  };
  reviewThreads: {
    totalCount: number;
    nodes: {
      isResolved: boolean;
      isOutdated?: boolean;
      path?: string | null;
      line?: number | null;
      comments: {
        nodes: {
          author: RawActor | null;
          bodyText?: string | null;
          url?: string | null;
        }[];
      };
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

const prFields = (updateBranchSupported: boolean): string => `
  ... on PullRequest {
    id number title url isDraft isInMergeQueue updatedAt headRefName baseRefName headRefOid reviewDecision mergeable${updateBranchSupported ? " viewerCanUpdateBranch" : ""}
    repository { nameWithOwner }
    author { __typename login }
    baseRef { branchProtectionRule { requiredApprovingReviewCount } }
    latestOpinionatedReviews(first: 30, writersOnly: true) { nodes { state url author { __typename login } } }
    reviewRequests(first: 20) { nodes { requestedReviewer {
      __typename
      ... on User { login }
      ... on Mannequin { login }
      ... on Bot { login }
      ... on Team { name }
    } } }
    reviewThreads(first: 100) {
      totalCount
      nodes {
        isResolved isOutdated path line
        comments(first: 1) { nodes { author { __typename login } bodyText url } }
      }
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

/** At most this many repos are listed for the repo picker. */
const MAX_REPOS = 1000;

type ReposPage = {
  viewer: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { nameWithOwner: string; isArchived: boolean }[];
    };
  };
};

/** Repos the account can access, most recently pushed first (capped). */
async function listViewerRepos(api: ApiTarget): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  while (out.length < MAX_REPOS) {
    const data: ReposPage = await graphql(api, REPOS_QUERY, { cursor });
    const r = data.viewer.repositories;
    for (const n of r.nodes) if (!n.isArchived) out.push(n.nameWithOwner);
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
}

type RulesetRule = { type: string; parameters?: { required_approving_review_count?: number } };

/**
 * Required approving reviews for a branch, read from repository rulesets
 * (readable with plain read access). Returns undefined when no rule applies
 * or the call fails.
 */
async function rulesetApprovals(api: ApiTarget, repo: string, branch: string): Promise<number | undefined> {
  try {
    const rules = await rest<RulesetRule[]>(api, `/repos/${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}`);
    const counts = (rules ?? [])
      .filter((r) => r.type === "pull_request")
      .map((r) => r.parameters?.required_approving_review_count ?? 0);
    return counts.length ? Math.max(...counts) : undefined;
  } catch {
    return undefined;
  }
}

export type UpdateMethod = "MERGE" | "REBASE";

const UPDATE_BRANCH = `
mutation($id: ID!, $head: GitObjectID, $method: PullRequestBranchUpdateMethod) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: $method }) {
    pullRequest { headRefOid }
  }
}`;

/** Everything the PR tab asks GitHub. */
export interface PrClient {
  search(api: ApiTarget, q: string): Promise<RawPullRequest[]>;
  viewerLogin(api: ApiTarget): Promise<string>;
  repos(api: ApiTarget): Promise<string[]>;
  requiredApprovals(api: ApiTarget, repo: string, branch: string): Promise<number | undefined>;
  /** Re-runs a workflow run's failed jobs, or all of them; throws with GitHub's message (e.g. still running). */
  rerun(api: ApiTarget, repo: string, runId: number, failedOnly: boolean): Promise<void>;
  /**
   * Brings a PR branch up to date with its base, like GitHub's "Update branch" button.
   * GitHub refuses if the branch moved past `expectedHeadOid`, so a newer push is never overwritten.
   */
  updateBranch(api: ApiTarget, prId: string, expectedHeadOid: string | undefined, method: UpdateMethod): Promise<void>;
}

/** The real client. Older GitHub Enterprise servers lack viewerCanUpdateBranch: it is dropped once one rejects it. */
export function gitHubPrClient(): PrClient {
  let updateBranchSupported = true;
  return {
    async search(api, q) {
      try {
        return await searchPrs<RawPullRequest>(api, prFields(updateBranchSupported), q, 4);
      } catch (e) {
        if (!updateBranchSupported || !/viewerCanUpdateBranch/.test((e as Error).message)) throw e;
        updateBranchSupported = false;
        return searchPrs<RawPullRequest>(api, prFields(false), q, 4);
      }
    },
    viewerLogin: async (api) => (await graphql<{ viewer: { login: string } }>(api, "{ viewer { login } }", {})).viewer.login,
    repos: listViewerRepos,
    requiredApprovals: rulesetApprovals,
    rerun: (api, repo, runId, failedOnly) =>
      restPost(
        api,
        `/repos/${repoPath(repo)}/actions/runs/${encodeURIComponent(String(runId))}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`,
      ),
    async updateBranch(api, prId, expectedHeadOid, method) {
      await graphql(api, UPDATE_BRANCH, { id: prId, head: expectedHeadOid ?? null, method }, true);
    },
  };
}
