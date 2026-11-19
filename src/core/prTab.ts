// The PR tab's data: searches GitHub for the chosen filters, turns each PR into a card view, and keeps the
// repo list for the picker. Only the newest refresh's results are kept.

import type { PanelConfig } from "./config";
import type { ApiTarget } from "./github";
import type { Connection, GitHubAuth } from "./githubAuth";
import type { PrClient, RawPullRequest } from "./githubPrs";
import type { TeamMember } from "./githubTeams";
import { LatestWins } from "./latestWins";
import { PrView, toView } from "./model";
import { prQueries } from "./prQuery";
import { TtlCache } from "./ttlCache";
import type { PrUi } from "./uiState";

const REPOS_TTL_MS = 30 * 60_000;
const APPROVALS_TTL_MS = 60 * 60_000;
const TEAMS_TTL_MS = 60 * 60_000;

interface PrTabDeps {
  client: PrClient;
  auth: GitHubAuth;
  config: () => PanelConfig;
  ui: () => PrUi;
  /** Something the panel shows changed. */
  changed: () => void;
  now?: () => number;
}

/** The PR tab's part of the payload. */
interface PrTabView {
  prs: PrView[];
  loading: boolean;
  error?: string;
  updatedAt?: number;
  repos: string[];
}

export class PrTab {
  private prs: PrView[] = [];
  private error?: string;
  private updatedAt = 0;
  private readonly refresher: LatestWins;
  private readonly repoCache = new TtlCache<string[]>(REPOS_TTL_MS);
  private readonly approvalsCache = new TtlCache<number | undefined>(APPROVALS_TTL_MS);
  private readonly teamsCache = new TtlCache<TeamMember[] | undefined>(TEAMS_TTL_MS);

  constructor(private readonly deps: PrTabDeps) {
    this.refresher = new LatestWins(deps.changed);
  }

  get lastRefresh(): number {
    return this.updatedAt;
  }

  /** A PR from the last refresh, by id. */
  find(id: string): PrView | undefined {
    return this.prs.find((p) => p.id === id);
  }

  /** The PRs in the order the webview sent their ids; unknown ids are skipped. */
  pick(ids: string[]): PrView[] {
    const byId = new Map(this.prs.map((p) => [p.id, p]));
    return ids.map((id) => byId.get(id)).filter((p): p is PrView => !!p);
  }

  /** Forgets the list (a filter or the account changed). */
  clear(): void {
    this.prs = [];
  }

  refresh(force: boolean): Promise<void> {
    return this.refresher.run(force, (isCurrent) => this.load(isCurrent), (e) => (this.error = e.message));
  }

  view(accountKey: string | undefined): PrTabView {
    return {
      prs: this.prs,
      loading: this.refresher.loading,
      error: this.error,
      updatedAt: this.updatedAt || undefined,
      repos: this.repoChoices(accountKey),
    };
  }

  private async load(isCurrent: () => boolean): Promise<void> {
    const gh = await this.deps.auth.connect();
    if (!isCurrent()) return;
    if (!gh) {
      this.prs = [];
      this.error = undefined;
      return;
    }
    const cfg = this.deps.config();
    const queries = prQueries(this.deps.ui(), { ...cfg, viewer: gh.viewer });
    const results = await Promise.all(queries.map((q) => this.deps.client.search(gh.api, q)));
    if (!isCurrent()) return;
    const unique = new Map(results.flat().map((pr) => [pr.id, pr]));
    const views = await Promise.all(
      [...unique.values()].map(async (pr) => toView(pr, await this.requiredApprovals(gh.api, pr, cfg), cfg)),
    );
    await this.addTeamMembers(gh.api, views);
    if (!isCurrent()) return;
    this.prs = views;
    this.error = undefined;
    this.updatedAt = (this.deps.now ?? Date.now)();
    // Warm the repo list in the background (for the picker).
    void this.warmRepos(gh).then(this.deps.changed);
  }

  /** Per-repo setting, else the branch rules, else branch protection, else the default setting. */
  /** Fills in who is in each pending code-owner team (cached; a team this account cannot see stays empty). */
  private async addTeamMembers(api: ApiTarget, views: PrView[]): Promise<void> {
    const teams = views.flatMap((v) => v.approvals.pendingOwnerTeams).filter((t) => t.org && t.slug);
    await Promise.all(
      teams.map(async (t) => {
        const [org, slug] = [t.org as string, t.slug as string];
        const load = () => this.deps.client.teamMembers(api, org, slug).catch(() => undefined);
        t.members = await this.teamsCache.get(`${org}/${slug}`, load);
      }),
    );
  }

  private async requiredApprovals(api: ApiTarget, pr: RawPullRequest, cfg: PanelConfig): Promise<number> {
    const repo = pr.repository.nameWithOwner;
    const override = cfg.requiredApprovalsPerRepo[repo];
    if (override !== undefined) return override;
    const fromRules = await this.approvalsCache.get(`${repo}@${pr.baseRefName}`, () =>
      this.deps.client.requiredApprovals(api, repo, pr.baseRefName),
    );
    return fromRules ?? pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ?? cfg.requiredApprovals;
  }

  private async warmRepos(gh: Connection): Promise<void> {
    await this.repoCache.get(gh.key, () => this.deps.client.repos(gh.api)).catch(() => undefined);
  }

  /** The account's repos within the organizations setting, plus every repo in the list, sorted. */
  private repoChoices(accountKey: string | undefined): string[] {
    const orgs = this.deps.config().organizations.map((o) => o.toLowerCase());
    const inScope = (r: string) => !orgs.length || orgs.includes(r.split("/")[0].toLowerCase());
    const known = accountKey ? (this.repoCache.peek(accountKey) ?? []) : [];
    const repos = new Set([...known.filter(inScope), ...this.prs.map((p) => p.repo)]);
    return [...repos].sort((a, b) => a.localeCompare(b));
  }
}
