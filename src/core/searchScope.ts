// Search qualifiers both tabs use: where to search and whose PRs.

/** "repo:owner/name" for one repo ("*" = all), else the organizations, else the fallback repos. */
export function repoScope(repo: string, organizations: string[], fallbackRepos: string[] = []): string {
  if (repo !== "*") return `repo:${repo}`;
  if (organizations.length) return organizations.map((o) => `org:${o}`).join(" ");
  return fallbackRepos.map((r) => `repo:${r}`).join(" ");
}

/** The logins behind a "who" choice: "@me" is the viewer, "@team" the team, anything else one login. */
export function loginsFor(who: string, viewer: string, team: string[]): string[] {
  if (who === "@me") return [viewer];
  return who === "@team" ? team : [who];
}
