// The PR tab's GitHub data shapes and the client contract. No network code: the real client lives in
// githubPrClient.ts and is created by the host, so the core depends only on this contract.

import type { ApiTarget } from "./github";
import type { TeamMember } from "./githubTeams";

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
      /** Requested because CODEOWNERS lists them for a changed file. */
      asCodeOwner?: boolean;
      requestedReviewer:
        | { __typename: "User" | "Mannequin" | "Bot"; login: string }
        | { __typename: "Team"; name: string; slug?: string; organization?: { login: string } | null }
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

export type UpdateMethod = "MERGE" | "REBASE";

export interface PrClient {
  search(api: ApiTarget, q: string): Promise<RawPullRequest[]>;
  viewerLogin(api: ApiTarget): Promise<string>;
  repos(api: ApiTarget): Promise<string[]>;
  requiredApprovals(api: ApiTarget, repo: string, branch: string): Promise<number | undefined>;
  /** Members of an organization team, or undefined when this account cannot see them. */
  teamMembers(api: ApiTarget, org: string, slug: string): Promise<TeamMember[] | undefined>;
  /** Re-runs a workflow run's failed jobs, or all of them; throws with GitHub's message (e.g. still running). */
  rerun(api: ApiTarget, repo: string, runId: number, failedOnly: boolean): Promise<void>;
  /**
   * Brings a PR branch up to date with its base, like GitHub's "Update branch" button.
   * GitHub refuses if the branch moved past `expectedHeadOid`, so a newer push is never overwritten.
   */
  updateBranch(api: ApiTarget, prId: string, expectedHeadOid: string | undefined, method: UpdateMethod): Promise<void>;
}
