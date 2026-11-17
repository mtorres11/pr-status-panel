import { randomBytes } from "crypto";
import * as vscode from "vscode";
import {
  apiTargetFor,
  ApiTarget,
  getRulesetRequiredApprovals,
  getViewerLogin,
  listViewerRepos,
  RawPullRequest,
  rerunWorkflowRun,
  searchPullRequests,
  UpdateMethod,
  updatePullRequestBranch,
} from "./github";
import { CopyFormat, copyText, inGroup } from "./copy";
import { PrView, toView } from "./model";
import { jiraOrigin, ticketUrl } from "./ticketLinks";
import { isHttpsUrl, isLogin } from "./validate";
import { DISPLAY_ONLY_KEYS } from "./deployFilters";
import { DeployPanel } from "./deployPanel";
import { TtlCache } from "./ttlCache";
import { fetchSnapshot, PanelConfig, readConfig } from "./config";
import type { Auth, AuthAccount, HostUi, KeyValueStore, Settings } from "./ports";
import { HostMessage, MessageHandlers, MessageOf, routeMessage } from "./protocol";
import { storedUi, UiState, validPatch } from "./uiState";
import { CFG, mementoStore, vscodeAuth, vscodeSettings, vscodeUi } from "./vscodeAdapters";

const SCOPES = ["repo", "read:org"];

const COPIED_AS: Record<CopyFormat, string> = {
  links: "",
  ticket: " with tickets and titles",
  markdown: " as a Markdown list",
};

interface AccountOption {
  key: string;
  providerId: string;
  account: AuthAccount;
  label: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PrStatusViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("prStatus.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("prStatus.refresh", () =>
      provider.refreshActive(true),
    ),
    vscode.commands.registerCommand("prStatus.addAccount", () =>
      provider.addAccount(),
    ),
    vscode.commands.registerCommand("prStatus.openSettings", () => provider.openSettings()),
    provider,
  );
}

export function deactivate(): void {
  /* nothing */
}

class PrStatusViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private generation = 0;
  private lastRefresh = 0;
  private lastSettings = "";
  private loading = false;
  private error?: string;
  private needsSignIn = false;
  private prs: PrView[] = [];
  private accounts: AccountOption[] = [];
  private viewerLogin?: string;
  private readonly repoCache = new TtlCache<string[]>(30 * 60_000);
  private readonly approvalsCache = new TtlCache<number | undefined>(3_600_000);

  readonly deploy: DeployPanel;
  private readonly hostUi: HostUi;
  private readonly settings: Settings = vscodeSettings;
  private readonly auth: Auth = vscodeAuth;
  private readonly store: KeyValueStore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.hostUi = vscodeUi(context.extension.id);
    this.store = mementoStore(context.globalState);
    this.deploy = new DeployPanel({
      github: async () => {
        await this.loadAccounts();
        const target = await this.api();
        this.needsSignIn = !target;
        if (!target) return undefined;
        this.viewerLogin ??= await getViewerLogin(target.api);
        return { api: target.api, viewer: this.viewerLogin };
      },
      ui: () => this.ui,
      post: () => this.post(),
      config: () => this.cfg(),
      settings: this.settings,
      hostUi: this.hostUi,
    });
    this.lastSettings = this.settingsSnapshot();
    this.disposables.push(
      vscode.authentication.onDidChangeSessions(() => this.refreshActive(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CFG)) return;
        const snapshot = this.settingsSnapshot();
        if (snapshot === this.lastSettings) {
          this.post(); // e.g. only favorites changed
          return;
        }
        this.lastSettings = snapshot;
        this.schedule();
        this.refreshActive(true);
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.isStale()) this.refreshActive(false);
      }),
    );
  }

  openSettings(): void {
    this.hostUi.openSettings("");
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ---------- Webview ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = this.html(view.webview, mediaRoot);
    view.webview.onDidReceiveMessage(
      (m) => routeMessage(this.handlers(), m),
      undefined,
      this.disposables,
    );
    view.onDidChangeVisibility(
      () => {
        if (view.visible && this.isStale()) this.refreshActive(false);
      },
      undefined,
      this.disposables,
    );
    view.onDidDispose(
      () => (this.view = undefined),
      undefined,
      this.disposables,
    );
    this.schedule();
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = randomBytes(24).toString("base64url");
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "main.css"),
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "main.js"));
    const deployJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "deploy.js"));
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>PR Status</title>
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${deployJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }

  /** What each webview message does. */
  private handlers(): MessageHandlers {
    return {
      ready: () => {
        this.post();
        void this.refreshActive(true);
      },
      refresh: () => this.refreshActive(true),
      setState: (m) => this.setState(m.patch),
      copyUrl: (m) => this.copyUrl(m),
      copyLinks: (m) => this.copyLinks(m),
      rerun: (m) => this.rerun(m.prId, m.failedOnly),
      updateBranch: (m) => this.updateBranch(m.prId, m.method),
      configureJira: (m) => this.configureJira(m.ticket),
      open: (m) => this.hostUi.openUrl(m.url),
      toggleFavorite: (m) => this.toggleFavorite(m.repo),
      addAccount: () => this.addAccount(),
      signIn: () => this.signIn(),
      openSettings: () => this.hostUi.openSettings(""),
      awsProfile: () => this.deploy.pickProfile(),
      awsSignIn: () => this.deploy.signIn(),
    };
  }

  /** Applies a UI change from the webview; "Other user…" first asks for the login. */
  private async setState(raw: Record<string, unknown>): Promise<void> {
    const patch = validPatch(raw, this.accounts.map((a) => a.key));
    if (patch.author === "@other") {
      const login = await this.hostUi.prompt({
        prompt: "GitHub username",
        placeHolder: "octocat",
        validate: (v) => (isLogin(v.trim().replace(/^@/, "")) ? undefined : "Not a valid GitHub username"),
      });
      const clean = login?.trim().replace(/^@/, "");
      if (!isLogin(clean)) return this.post();
      patch.author = clean;
    }
    if (!Object.keys(patch).length) return this.post();
    await this.setUi(patch);
    await this.afterUiChange(Object.keys(patch));
  }

  /** Copies one PR or ticket link. The URL comes from our own PR data, never from the webview message. */
  private async copyUrl(m: MessageOf<"copyUrl">): Promise<void> {
    const pr = this.prs.find((p) => p.id === m.prId);
    const url = m.which === "ticket" ? pr?.ticketUrl : pr?.url;
    if (!pr || !isHttpsUrl(url)) return;
    await this.hostUi.copy(url, `Copied ${m.which === "ticket" ? `${pr.ticket} link` : `PR #${pr.number} link`}`);
  }

  /** Saves the Jira site for ticket links, then opens the ticket that was clicked. */
  private async configureJira(ticket: string): Promise<void> {
    const input = await this.hostUi.prompt({
      title: "PR Status: Jira site for ticket links",
      prompt: "Paste your Jira site or any Jira link (e.g. your board URL). Only the site part is kept.",
      placeHolder: "https://yourcompany.atlassian.net",
      ignoreFocusOut: true,
      validate: (v) => (jiraOrigin(v) ? undefined : "Enter a valid Jira URL"),
    });
    const origin = input ? jiraOrigin(input) : "";
    if (!origin) return;
    await this.settings.update("jiraBaseUrl", origin);
    const url = ticketUrl(origin, ticket);
    if (url && /^[A-Za-z0-9_-]{1,64}$/.test(ticket)) this.hostUi.openUrl(url);
  }

  private async toggleFavorite(repo: string): Promise<void> {
    const favs = new Set(this.settings.get<string[]>("favoriteRepos", []));
    if (favs.has(repo)) favs.delete(repo);
    else favs.add(repo);
    await this.settings.update("favoriteRepos", [...favs].sort());
  }

  /** Fetches again only what a UI change affects. */
  private async afterUiChange(keys: string[]): Promise<void> {
    const displayOnly = ["copyGroup", "copyFormat", ...DISPLAY_ONLY_KEYS];
    if (keys.every((k) => displayOnly.includes(k))) return this.post();
    if (keys.every((k) => k === "tab")) {
      this.post();
      if (this.isStale()) await this.refreshActive(true);
      return;
    }
    if (keys.some((k) => k.startsWith("deploy"))) return this.deploy.reload();
    this.prs = [];
    await this.refreshActive(true);
  }

  /** Credit line shown in the panel footer, taken from package.json. */
  private about(): { author: string; repoUrl: string; version: string } {
    const pkg = this.context.extension.packageJSON as {
      version?: string;
      author?: { name?: string } | string;
      repository?: { url?: string } | string;
    };
    const author =
      typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "");
    const rawRepo =
      typeof pkg.repository === "string"
        ? pkg.repository
        : (pkg.repository?.url ?? "");
    return {
      author,
      repoUrl: rawRepo.replace(/^git\+/, "").replace(/\.git$/, ""),
      version: pkg.version ?? "",
    };
  }

  // ---------- Actions ----------

  /**
   * Copy the links of the shown PRs in one group, in the order shown. Every id is checked
   * against the group again here, so the panel can never copy PRs outside it.
   */
  private async copyLinks(m: MessageOf<"copyLinks">): Promise<void> {
    const byId = new Map(this.prs.map((p) => [p.id, p]));
    const prs = m.ids
      .map((id) => byId.get(id))
      .filter((p): p is PrView => !!p && inGroup(p, m.group) && isHttpsUrl(p.url) && (!p.ticketUrl || isHttpsUrl(p.ticketUrl)));
    if (!prs.length) {
      this.hostUi.info("PR Status: no PRs in this group in the list.");
      return;
    }
    await this.hostUi.copy(copyText(prs, m.format, m.group === "all"));
    this.hostUi.info(`PR Status: copied ${prs.length} PR link${prs.length === 1 ? "" : "s"}${COPIED_AS[m.format]}.`);
  }

  /** Re-run failed jobs (or all jobs) of the GitHub Actions runs behind a PR's checks. */
  private async rerun(prId: string, failedOnly: boolean): Promise<void> {
    const pr = this.prs.find((p) => p.id === prId);
    if (!pr) return;
    // "failed" needs a failed Actions run; "all" works for any PR with Actions runs, failing or not.
    const runIds = failedOnly ? pr.rerun.failedRunIds : pr.rerun.allRunIds;
    if (!runIds.length) {
      this.hostUi.warn(
        failedOnly
          ? `PR Status: none of the failing checks on #${pr.number} are GitHub Actions workflows yet. Try Re-run all checks.`
          : `PR Status: no GitHub Actions workflows are behind the checks on #${pr.number}, so nothing can be re-run from here.`,
      );
      return;
    }
    const what = failedOnly
      ? `the failed jobs in ${runIds.length} workflow run(s)`
      : `all jobs in ${runIds.length} workflow run(s)`;
    const ok = await this.hostUi.confirm(
      `Re-run ${what} for ${pr.repo}#${pr.number}?`,
      pr.title,
      failedOnly ? "Re-run failed" : "Re-run all",
    );
    if (!ok) return;

    const target = await this.api();
    if (!target) {
      this.hostUi.error("PR Status: sign in to GitHub first.");
      return;
    }
    const errors: string[] = [];
    await this.hostUi.progress(`Re-running checks for #${pr.number}…`, async () => {
        for (const id of runIds) {
          try {
            await rerunWorkflowRun(target.api, pr.repo, id, failedOnly);
          } catch (e) {
            errors.push(`run ${id}: ${(e as Error).message}`);
          }
        }
    });
    const restarted = runIds.length - errors.length;
    if (errors.length) {
      this.hostUi.error(
        `PR Status: ${restarted} of ${runIds.length} run(s) restarted. ${errors.join("; ")}`,
      );
    } else {
      this.hostUi.info(
        `PR Status: restarted ${restarted} workflow run(s) for #${pr.number}.` +
          (pr.rerun.failedExternal
            ? ` ${pr.rerun.failedExternal} failing non-Actions check(s) were skipped.`
            : ""),
      );
    }
    // Give GitHub a moment to queue the jobs, then refresh.
    setTimeout(() => this.refreshActive(true), 5000);
  }

  /** Bring a PR branch up to date with its base (GitHub's "Update branch"), after confirming. */
  private async updateBranch(prId: string, method: UpdateMethod): Promise<void> {
    const pr = this.prs.find((p) => p.id === prId);
    if (!pr) return;
    if (!pr.canUpdateBranch) {
      this.hostUi.info(
        `PR Status: #${pr.number} is up to date with ${pr.baseRef}, or you can't push to its branch.`,
      );
      return;
    }
    const rebase = method === "REBASE";
    const detail = [
      pr.title,
      "",
      rebase
        ? `Replays the branch's commits on top of ${pr.baseRef}. This rewrites the branch: anyone with a local copy must reset it (for example git pull --rebase).`
        : `Merges ${pr.baseRef} into the branch with a merge commit, like GitHub's Update branch button.`,
      "Checks will run again. If the repository dismisses stale approvals, existing approvals are removed.",
    ].join("\n");
    const ok = await this.hostUi.confirm(
      `${rebase ? "Rebase" : "Update"} ${pr.repo}#${pr.number} onto the latest ${pr.baseRef}?`,
      detail,
      rebase ? "Rebase branch" : "Update branch",
    );
    if (!ok) return;
    const target = await this.api();
    if (!target) {
      this.hostUi.error("PR Status: sign in to GitHub first.");
      return;
    }
    try {
      await this.hostUi.progress(`Updating #${pr.number} with ${pr.baseRef}…`, () =>
        updatePullRequestBranch(target.api, pr.id, pr.headOid, method),
      );
      this.hostUi.info(`PR Status: #${pr.number} is now up to date with ${pr.baseRef}.`);
    } catch (e) {
      const msg = (e as Error).message;
      this.hostUi.error(
        /expected head|head sha|not match/i.test(msg)
          ? `PR Status: #${pr.number} changed since the last refresh, so it was not updated. The list is refreshing; try again.`
          : `PR Status: could not update #${pr.number}: ${msg}`,
      );
    }
    // GitHub needs a moment to register the new head and start checks.
    setTimeout(() => this.refreshActive(true), 4000);
  }

  // ---------- State ----------

  private get ui(): UiState {
    return storedUi(this.store.get("ui"));
  }

  private async setUi(patch: Partial<UiState>): Promise<void> {
    await this.store.set("ui", { ...this.ui, ...patch });
  }

  private cfg(): PanelConfig {
    return readConfig(this.settings);
  }

  private settingsSnapshot(): string {
    return fetchSnapshot(this.cfg());
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.view?.visible && vscode.window.state.focused)
        this.refreshActive(false);
    }, this.cfg().refreshIntervalSeconds * 1000);
  }

  /** The tab on screen has not been refreshed within the refresh interval. */
  private isStale(): boolean {
    const at = this.ui.tab === "deploy" ? this.deploy.updatedAt : this.lastRefresh;
    return Date.now() - at > this.cfg().refreshIntervalSeconds * 1000;
  }

  // ---------- Accounts ----------

  private providerIds(): string[] {
    return this.cfg().enterpriseUri
      ? ["github", "github-enterprise"]
      : ["github"];
  }

  private async loadAccounts(): Promise<void> {
    const out: AccountOption[] = [];
    for (const providerId of this.providerIds()) {
      try {
        const accts = await this.auth.accounts(providerId);
        for (const account of accts) {
          out.push({
            key: `${providerId}:${account.id}`,
            providerId,
            account,
            label: `${account.label} (${providerId === "github" ? "github.com" : "Enterprise"})`,
          });
        }
      } catch {
        // provider not available
      }
    }
    this.accounts = out;
  }

  async addAccount(): Promise<void> {
    const providerId =
      this.providerIds().length > 1
        ? (
            await this.hostUi.pick(
              [
                { label: "github.com", id: "github" },
                { label: "GitHub Enterprise", id: "github-enterprise" },
              ],
              "Which GitHub?",
            )
          )?.id
        : "github";
    if (!providerId) return;
    try {
      const session = await this.auth.session(providerId, SCOPES, {
        clearSessionPreference: true,
        createIfNone: true,
      });
      if (!session) return;
      await this.setUi({ accountKey: `${providerId}:${session.account.id}` });
      this.refreshActive(true);
    } catch (e) {
      this.hostUi.error(`PR Status: sign-in failed: ${(e as Error).message}`);
    }
  }

  private async signIn(): Promise<void> {
    const acct = this.currentAccount();
    try {
      const session = await this.auth.session(acct?.providerId ?? "github", SCOPES, {
        createIfNone: true,
        account: acct?.account,
      });
      if (!session) return;
      await this.setUi({
        accountKey: `${acct?.providerId ?? "github"}:${session.account.id}`,
      });
      this.refreshActive(true);
    } catch (e) {
      this.hostUi.error(`PR Status: sign-in failed: ${(e as Error).message}`);
    }
  }

  private currentAccount(): AccountOption | undefined {
    const key = this.ui.accountKey;
    return this.accounts.find((a) => a.key === key) ?? this.accounts[0];
  }

  private async api(): Promise<{ api: ApiTarget; key: string } | undefined> {
    const acct = this.currentAccount();
    if (!acct) return undefined;
    const session = await this.auth.session(acct.providerId, SCOPES, {
      account: acct.account,
      silent: true,
    });
    if (!session) return undefined;
    const enterprise =
      acct.providerId === "github-enterprise"
        ? this.cfg().enterpriseUri
        : undefined;
    return {
      api: apiTargetFor(enterprise, session.accessToken),
      key: acct.key,
    };
  }

  // ---------- Data ----------

  /** Refreshes the tab on screen. */
  async refreshActive(force: boolean): Promise<void> {
    if (this.ui.tab !== "deploy") return this.refresh(force);
    if (this.view && (force || !this.deploy.loading)) await this.deploy.refresh();
  }

  async refresh(force: boolean): Promise<void> {
    if (!this.view) return;
    if (!force && this.loading) return;
    const gen = ++this.generation;
    this.loading = true;
    this.post();
    try {
      await this.loadAccounts();
      const target = await this.api();
      if (gen !== this.generation) return;
      if (!target) {
        this.needsSignIn = true;
        this.prs = [];
        this.error = undefined;
        return;
      }
      this.needsSignIn = false;
      const cfg = this.cfg();
      const ui = this.ui;
      this.viewerLogin = await getViewerLogin(target.api);

      const authors =
        ui.author === "@me"
          ? [this.viewerLogin]
          : ui.author === "@team"
            ? cfg.teamMembers
            : [ui.author];
      const roles: string[] =
        ui.show === "authored"
          ? ["author"]
          : ui.show === "review"
            ? ["review-requested"]
            : ui.show === "assigned"
              ? ["assignee"]
              : ["author", "review-requested", "assignee"];
      const scope =
        ui.repo !== "*"
          ? `repo:${ui.repo}`
          : cfg.organizations.map((o) => `org:${o}`).join(" ");
      const base =
        `is:pr is:open archived:false ${ui.drafts ? "" : "draft:false "}${scope}`.trim();

      const queries = authors.flatMap((u) =>
        roles.map((r) => `${base} ${r}:${u}`),
      );
      const results = await Promise.all(
        queries.map((q) => searchPullRequests(target.api, q)),
      );
      if (gen !== this.generation) return;

      const unique = new Map<string, RawPullRequest>();
      for (const pr of results.flat()) unique.set(pr.id, pr);

      const views = await Promise.all(
        [...unique.values()].map(async (pr) =>
          toView(pr, await this.requiredApprovals(target.api, pr), cfg),
        ),
      );
      if (gen !== this.generation) return;

      this.prs = views;
      this.error = undefined;
      this.lastRefresh = Date.now();
      // Warm repo list in the background (for the dropdown).
      void this.repos(target.api, target.key).then(() => this.post());
    } catch (e) {
      if (gen === this.generation) this.error = (e as Error).message;
    } finally {
      if (gen === this.generation) {
        this.loading = false;
        this.post();
      }
    }
  }

  private async requiredApprovals(
    api: ApiTarget,
    pr: RawPullRequest,
  ): Promise<number> {
    const cfg = this.cfg();
    const repo = pr.repository.nameWithOwner;
    if (cfg.requiredApprovalsPerRepo[repo] !== undefined)
      return cfg.requiredApprovalsPerRepo[repo];
    const fromRules = await this.approvalsCache.get(`${repo}@${pr.baseRefName}`, () =>
      getRulesetRequiredApprovals(api, repo, pr.baseRefName),
    );
    return (
      fromRules ??
      pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ??
      cfg.requiredApprovals
    );
  }

  private repoListFor(key: string): string[] {
    return this.repoCache.peek(key) ?? [];
  }

  private async repos(api: ApiTarget, key: string): Promise<string[]> {
    try {
      return await this.repoCache.get(key, () => listViewerRepos(api));
    } catch {
      return this.repoCache.peek(key) ?? [];
    }
  }

  private post(): void {
    if (!this.view) return;
    const cfg = this.cfg();
    const acct = this.currentAccount();
    const orgs = cfg.organizations.map((o) => o.toLowerCase());
    const inScope = (r: string) =>
      !orgs.length || orgs.includes(r.split("/")[0].toLowerCase());
    const repos = new Set<string>([
      ...(acct ? this.repoListFor(acct.key) : []).filter(inScope),
      ...this.prs.map((p) => p.repo),
    ]);
    const message: HostMessage = {
      type: "update",
      payload: {
        ui: { ...this.ui, accountKey: acct?.key },
        accounts: this.accounts.map((a) => ({ key: a.key, label: a.label })),
        viewerLogin: this.viewerLogin,
        team: cfg.teamMembers,
        favorites: cfg.favoriteRepos,
        repos: [...repos].sort((a, b) => a.localeCompare(b)),
        prs: this.prs,
        loading: this.loading,
        error: this.error,
        needsSignIn: this.needsSignIn,
        updatedAt: this.lastRefresh || undefined,
        compact: cfg.compact,
        groupByRepo: cfg.groupByRepo,
        about: this.about(),
        deploy: this.deploy.payload(),
      },
    };
    void this.view.webview.postMessage(message);
  }
}
