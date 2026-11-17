// The GitHub searches behind the PR tab's filters.

import { loginsFor, repoScope } from "./searchScope";
import type { PrUi, ShowMode } from "./uiState";

/** Search qualifiers for each "Show" choice. */
const ROLES: Record<ShowMode, string[]> = {
  authored: ["author"],
  review: ["review-requested"],
  assigned: ["assignee"],
  all: ["author", "review-requested", "assignee"],
};

interface PrSearchContext {
  viewer: string;
  teamMembers: string[];
  organizations: string[];
}

/** One search per author and role, all open PRs in the chosen scope. */
export function prQueries(ui: PrUi, ctx: PrSearchContext): string[] {
  const scope = repoScope(ui.repo, ctx.organizations);
  const base = `is:pr is:open archived:false ${ui.drafts ? "" : "draft:false "}${scope}`.trim();
  const authors = loginsFor(ui.author, ctx.viewer, ctx.teamMembers);
  return authors.flatMap((u) => ROLES[ui.show].map((r) => `${base} ${r}:${u}`));
}
