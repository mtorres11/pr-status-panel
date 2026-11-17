// Matching pull requests to tickets, and reading PR references typed by the user.

import { MAX_REGEX_INPUT } from "./validate";

/** Accepts "owner/repo#123", a PR URL, or "#123"/"123" (needs a default repo). */
export function parsePrRef(
  input: string,
  defaultRepo?: string,
): { repo: string; number: number } | undefined {
  const v = input.trim().slice(0, 300);
  const url = v.match(
    /^https:\/\/[^/]+\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d{1,9})/,
  );
  if (url) return { repo: url[1], number: Number(url[2]) };
  const full = v.match(/^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d{1,9})$/);
  if (full) return { repo: full[1], number: Number(full[2]) };
  const bare = v.match(/^#?(\d{1,9})$/);
  if (bare && defaultRepo)
    return { repo: defaultRepo, number: Number(bare[1]) };
  return undefined;
}

function safeRegex(src: string): RegExp | undefined {
  try {
    return new RegExp(src, "g");
  } catch {
    return undefined;
  }
}

/** Every ticket key a PR mentions in its branch name or title. */
export function ticketsOf(
  pr: { headRefName: string; title: string },
  pattern: string,
): string[] {
  const re = safeRegex(pattern);
  if (!re) return [];
  const text = `${pr.headRefName.slice(0, MAX_REGEX_INPUT)} ${pr.title.slice(0, MAX_REGEX_INPUT)}`;
  return [...new Set([...text.matchAll(re)].map((m) => m[0].toUpperCase()))];
}

/** First ticket key (e.g. PROJ-123) in free text or a Jira link, upper-cased. */
export function ticketKeyIn(text: string): string | undefined {
  return text.toUpperCase().slice(0, 300).match(/\b[A-Z][A-Z0-9_]{0,19}-\d{1,9}\b/)?.[0];
}
