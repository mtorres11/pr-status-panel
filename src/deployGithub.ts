// GitHub reads for the Deployments tab: a light PR search, a single PR, and a branch's commit list used
// to answer "is commit X already in branch Y?" without one API call per question.

import { ApiTarget, graphql, rest, searchPrs } from "./github";
import { TtlCache } from "./ttlCache";
import { repoPath, SHA_RE } from "./validate";

const BRANCH_TTL_MS = 3 * 60_000;

export interface DeployRawPr {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: string | null;
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  mergedBy: { login: string } | null;
}

const FIELDS = `... on PullRequest {
  id number title url isDraft state createdAt updatedAt mergedAt mergeCommit { oid }
  headRefName headRefOid baseRefName reviewDecision
  repository { nameWithOwner } author { login } mergedBy { login }
}`;

const ONE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${FIELDS} } }
}`;

export function searchDeployPrs(api: ApiTarget, q: string): Promise<DeployRawPr[]> {
  return searchPrs<DeployRawPr>(api, FIELDS, q, 2);
}

export async function getDeployPr(
  api: ApiTarget,
  repo: string,
  number: number,
): Promise<DeployRawPr | undefined> {
  const [owner, name] = repo.split("/");
  type Data = { repository: { pullRequest: DeployRawPr | null } | null };
  const data = await graphql<Data>(api, ONE, { owner, name, number });
  return data?.repository?.pullRequest ?? undefined;
}

/** A branch's recent history: position of each commit (0 = newest) and the first line of its message. */
export interface BranchIndex {
  branch: string;
  /** Oldest commit date covered; older commits fall back to a compare call. */
  since: string;
  position: Map<string, number>;
  commits: { sha: string; message: string; date: string }[];
}

type RestCommit = { sha: string; commit: { message: string; committer?: { date?: string } } };

/** Commits on `branch` since `since` (up to 1000), newest first, or undefined when there are none. */
async function loadIndex(
  api: ApiTarget,
  repo: string,
  branch: string,
  since: string,
): Promise<BranchIndex | undefined> {
  const commits: BranchIndex["commits"] = [];
  for (let page = 1; page <= 10; page++) {
    const q = `sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`;
    const batch = await rest<RestCommit[]>(api, `/repos/${repoPath(repo)}/commits?${q}`);
    if (!batch) break;
    commits.push(
      ...batch.map((c) => ({
        sha: c.sha,
        message: c.commit.message.split("\n")[0],
        date: c.commit.committer?.date ?? "",
      })),
    );
    if (batch.length < 100) break;
  }
  if (!commits.length) return undefined;
  return { branch, since, position: new Map(commits.map((c, i) => [c.sha, i])), commits };
}

export class BranchCommits {
  private readonly indexes = new TtlCache<BranchIndex | undefined>(BRANCH_TTL_MS);
  /** Answers for commit pairs, which never change. */
  private readonly contains = new TtlCache<boolean>(Infinity);

  /** Commits on `branch` since `since` (up to 1000), or undefined when the branch does not exist. */
  index(api: ApiTarget, repo: string, branch: string, since: string): Promise<BranchIndex | undefined> {
    return this.indexes.get(`${repo}@${branch}@${since.slice(0, 10)}`, () => loadIndex(api, repo, branch, since));
  }

  /** `sha` is part of `ref` (a branch or commit). Uses the index when both are in it, else one compare call. */
  async isIn(
    api: ApiTarget,
    repo: string,
    sha: string,
    ref: string,
    idx?: BranchIndex,
  ): Promise<boolean | undefined> {
    const a = idx?.position.get(sha);
    const b = idx?.position.get(ref) ?? (ref === idx?.branch ? 0 : undefined);
    if (a !== undefined && b !== undefined) return b <= a;
    const key = `${repo}:${sha}:${ref}`;
    const known = this.contains.peek(key);
    if (known !== undefined) return known;
    const cmp = await rest<{ status?: string }>(
      api,
      `/repos/${repoPath(repo)}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(ref)}`,
    );
    if (!cmp?.status) return undefined;
    const yes = cmp.status === "ahead" || cmp.status === "identical";
    if (SHA_RE.test(ref)) this.contains.set(key, yes); // only commit pairs never change
    return yes;
  }
}
