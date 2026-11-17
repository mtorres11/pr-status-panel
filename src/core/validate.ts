// Input validation for anything that crosses a trust boundary
// (webview messages, user settings) before it reaches a URL or a search query.

/** GitHub usernames / org names: alphanumerics and single hyphens, max 39 chars. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** owner/name with GitHub's allowed characters. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** A full git commit id. */
export const SHA_RE = /^[0-9a-f]{40}$/i;

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

/** A RegExp from user text, or undefined when the text is not a valid pattern. */
export function safeRegex(src: string, flags = ""): RegExp | undefined {
  try {
    return new RegExp(src, flags);
  } catch {
    return undefined;
  }
}

/** A plain object from untrusted input, or an empty one. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A check that accepts only the values in `list`. */
export function oneOf<T>(list: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => list.includes(v as T);
}

/** The fields of `p` that pass their rule, after `normalize`; unknown keys and failing values are dropped. */
export function pickValid<T>(
  p: Record<string, unknown>,
  rules: { [K in keyof T]: (v: unknown) => boolean },
  normalize: (key: string, v: unknown) => unknown = (_k, v) => v,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, ok] of Object.entries(rules) as [string, (v: unknown) => boolean][]) {
    const v = normalize(k, p[k]);
    if (v !== undefined && ok(v)) out[k] = v;
  }
  return out as Partial<T>;
}
