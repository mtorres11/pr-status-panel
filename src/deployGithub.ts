// GitHub reads for the Deployments tab: a light PR search, a single PR, and a branch's commit list used
// to answer "is commit X already in branch Y?" without one API call per question.

import { ApiTarget, graphql } from "./github";
import { repoPath } from "./validate";

const REQUEST_TIMEOUT_MS = 20_000;
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

const SEARCH = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ${FIELDS} }
  }
}`;

const ONE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${FIELDS} } }
}`;

type SearchPage = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (DeployRawPr | Record<string, never>)[];
  };
};

export async function searchDeployPrs(
  api: ApiTarget,
  q: string,
  maxPages = 2,
): Promise<DeployRawPr[]> {
  const out: DeployRawPr[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: SearchPage = await graphql(api, SEARCH, { q, cursor });
    out.push(
      ...data.search.nodes.filter((n): n is DeployRawPr => !!n && "id" in n),
    );
    if (!data.search.pageInfo.hasNextPage) break;
    cursor = data.search.pageInfo.endCursor;
  }
  return out;
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

async function rest<T>(api: ApiTarget, path: string): Promise<T | undefined> {
  const res = await fetch(`${api.restBase}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${api.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pr-status-panel",
    },
  });
  return res.ok ? ((await res.json()) as T) : undefined;
}

/** A branch's recent history: position of each commit (0 = newest) and the first line of its message. */
export interface BranchIndex {
  branch: string;
  /** Oldest commit date covered; older commits fall back to a compare call. */
  since: string;
  position: Map<string, number>;
  commits: { sha: string; message: string; date: string }[];
}

export class BranchCommits {
  private cache = new Map<
    string,
    { at: number; value: BranchIndex | undefined }
  >();
  private contains = new Map<string, boolean>();

  /** Commits on `branch` since `since` (up to 1000), or undefined when the branch does not exist. */
  async index(
    api: ApiTarget,
    repo: string,
    branch: string,
    since: string,
  ): Promise<BranchIndex | undefined> {
    const key = `${repo}@${branch}@${since.slice(0, 10)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return cached.value;
    const commits: BranchIndex["commits"] = [];
    for (let page = 1; page <= 10; page++) {
      const q = `sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`;
      const batch = await rest<
        {
          sha: string;
          commit: { message: string; committer?: { date?: string } };
        }[]
      >(api, `/repos/${repoPath(repo)}/commits?${q}`);
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
    const value = commits.length
      ? {
          branch,
          since,
          position: new Map(commits.map((c, i) => [c.sha, i])),
          commits,
        }
      : undefined;
    this.cache.set(key, { at: Date.now(), value });
    return value;
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
    if (this.contains.has(key)) return this.contains.get(key);
    const cmp = await rest<{ status?: string }>(
      api,
      `/repos/${repoPath(repo)}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(ref)}`,
    );
    if (!cmp?.status) return undefined;
    const yes = cmp.status === "ahead" || cmp.status === "identical";
    if (/^[0-9a-f]{40}$/i.test(ref)) this.contains.set(key, yes); // only commit pairs never change
    return yes;
  }
}
