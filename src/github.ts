// Thin GitHub API transport: GraphQL and REST calls with the token, a timeout and GitHub's error messages.
// The token is only ever sent to api.github.com or to the https GitHub Enterprise
// host the user configured in VS Code's own "github-enterprise.uri" user setting.

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

export class GitHubError extends Error {}

/** Headers for every call: the token, and the client name GitHub asks for. */
function headers(api: ApiTarget, extra: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${api.token}`, "User-Agent": "pr-status-panel", ...extra };
}

export async function graphql<T>(
  api: ApiTarget,
  query: string,
  variables: Record<string, unknown>,
  /** Throw on any GraphQL error, even with partial data (used for mutations). */
  strict = false,
): Promise<T> {
  const res = await fetch(api.graphqlUrl, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: "POST",
    headers: headers(api, { "Content-Type": "application/json" }),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new GitHubError(`GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors?.length && (strict || !body.data)) {
    throw new GitHubError(body.errors.map((e) => e.message).join("; "));
  }
  return body.data as T;
}

/** One REST call with the token, GitHub's JSON media type and the request timeout. */
async function request(
  api: ApiTarget,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  return fetch(`${api.restBase}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method,
    headers: headers(api, { Accept: "application/vnd.github+json" }),
  });
}

/** POST to a REST path; throws a GitHubError with GitHub's message (or the status code) when it fails. */
export async function restPost(api: ApiTarget, path: string): Promise<void> {
  const res = await request(api, path, "POST");
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new GitHubError(body.message ?? `${res.status}`);
}

/** GET a REST path as JSON; undefined when GitHub answers with an error status. */
export async function rest<T>(api: ApiTarget, path: string): Promise<T | undefined> {
  const res = await request(api, path);
  return res.ok ? ((await res.json()) as T) : undefined;
}

type SearchPage<T> = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (T | Record<string, never>)[];
  };
};

/** Pull requests matching a search, `fields` being the GraphQL selection for each one, up to `maxPages` of 50. */
export async function searchPrs<T extends { id: string }>(
  api: ApiTarget,
  fields: string,
  q: string,
  maxPages: number,
): Promise<T[]> {
  const query = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ${fields} }
  }
}`;
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: SearchPage<T> = await graphql(api, query, { q, cursor });
    out.push(...data.search.nodes.filter((n): n is T => !!n && "id" in n));
    if (!data.search.pageInfo.hasNextPage) break;
    cursor = data.search.pageInfo.endCursor;
  }
  return out;
}
