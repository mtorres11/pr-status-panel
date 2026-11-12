// Input validation for anything that crosses a trust boundary
// (webview messages, user settings) before it reaches a URL or a search query.

/** GitHub usernames / org names: alphanumerics and single hyphens, max 39 chars. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** owner/name with GitHub's allowed characters. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Max length of text fed to user-configured regexes (limits catastrophic backtracking). */
export const MAX_REGEX_INPUT = 256;

export function isLogin(v: unknown): v is string {
  return typeof v === "string" && LOGIN_RE.test(v);
}

export function isRepo(v: unknown): v is string {
  if (typeof v !== "string" || !REPO_RE.test(v)) return false;
  const name = v.split("/")[1];
  return name !== "." && name !== "..";
}

export function logins(values: unknown): string[] {
  return Array.isArray(values) ? values.filter(isLogin) : [];
}

export function repos(values: unknown): string[] {
  return Array.isArray(values) ? values.filter(isRepo) : [];
}

/** https URL check used before handing a link to the OS browser. */
export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Encodes "owner/name" for use in a REST path. */
export function repoPath(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}
