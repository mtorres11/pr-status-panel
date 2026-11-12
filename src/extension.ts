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
} from "./github";
import { jiraOrigin, PrView, toView } from "./model";
import { isHttpsUrl, isLogin, isRepo, logins, repos } from "./validate";

const SHOW_MODES = ["authored", "review", "assigned", "all"] as const;
const SORT_MODES = ["attention", "updated", "ticket"] as const;

const SCOPES = ["repo", "read:org"];
const CFG = "prStatus";

type ShowMode = "authored" | "review" | "assigned" | "all";
type SortMode = "attention" | "updated" | "ticket";

interface UiState {
  accountKey?: string;
  author: string; // '@me' | '@team' | login
  repo: string; // '*' | 'owner/name'
  show: ShowMode;
  drafts: boolean;
  sort: SortMode;
  addDescription: boolean;
}

const DEFAULT_UI: UiState = {
  author: "@me",
  repo: "*",
  show: "authored",
  drafts: true,
  sort: "attention",
  addDescription: false,
};

interface AccountOption {
  key: string;
  providerId: string;
  account: vscode.AuthenticationSessionAccountInformation;
  label: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PrStatusViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("prStatus.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("prStatus.refresh", () =>
      provider.refresh(true),
    ),
    vscode.commands.registerCommand("prStatus.addAccount", () =>
      provider.addAccount(),
    ),
    vscode.commands.registerCommand("prStatus.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id}`,
      ),
    ),
    provider,
  );
}

export function deactivate(): void {
  /* nothing */
}

/**
 * GitHub Enterprise Server URL, read ONLY from the user-level value of VS Code's
 * own "github-enterprise.uri" setting (the server VS Code's GitHub Enterprise
 * sign-in uses). Workspace/folder values are ignored on purpose, so a cloned
 * repository's .vscode/settings.json can never redirect the token elsewhere.
 * Returns "" unless it is a valid https URL.
 */
function enterpriseUri(): string {
  const v = vscode.workspace
    .getConfiguration("github-enterprise")
    .inspect<string>("uri")?.globalValue;
  return isHttpsUrl(v) ? v : "";
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
  private repoCache = new Map<string, { at: number; repos: string[] }>();
  private approvalsCache = new Map<
    string,
    { at: number; value: number | undefined }
  >();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.lastSettings = this.settingsSnapshot();
    this.disposables.push(
      vscode.authentication.onDidChangeSessions(() => this.refresh(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CFG)) return;
        const snapshot = this.settingsSnapshot();
        if (snapshot === this.lastSettings) {
          this.post(); // e.g. only favorites changed
          return;
        }
        this.lastSettings = snapshot;
        this.schedule();
        this.refresh(true);
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.isStale()) this.refresh(false);
      }),
    );
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
      (m) => this.onMessage(m),
      undefined,
      this.disposables,
    );
    view.onDidChangeVisibility(
      () => {
        if (view.visible && this.isStale()) this.refresh(false);
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
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>PR Status</title>
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }

  private async onMessage(m: {
    type: string;
    [k: string]: unknown;
  }): Promise<void> {
    switch (m.type) {
      case "ready":
        this.post();
        this.refresh(true);
        break;
      case "refresh":
        this.refresh(true);
        break;
      case "setState": {
        const patch = this.validPatch(m.patch);
        if (patch.author === "@other") {
          const login = await vscode.window.showInputBox({
            prompt: "GitHub username",
            placeHolder: "octocat",
            validateInput: (v) =>
              isLogin(v.trim().replace(/^@/, ""))
                ? undefined
                : "Not a valid GitHub username",
          });
          const clean = login?.trim().replace(/^@/, "");
          if (!isLogin(clean)) {
            this.post();
            return;
          }
          patch.author = clean;
        }
        if (!Object.keys(patch).length) {
          this.post();
          return;
        }
        await this.setUi(patch);
        if (Object.keys(patch).every((k) => k === "addDescription")) {
          this.post();
          break;
        }
        this.prs = [];
        this.refresh(true);
        break;
      }
      case "copyLinks":
        await this.copyLinks(m.ids, m.withDescription === true);
        break;
      case "rerun":
        await this.rerun(String(m.prId ?? ""), m.mode === "failed");
        break;
      case "configureJira": {
        const input = await vscode.window.showInputBox({
          title: "PR Status: Jira site for ticket links",
          prompt:
            "Paste your Jira site or any Jira link (e.g. your board URL). Only the site part is kept.",
          placeHolder: "https://yourcompany.atlassian.net",
          ignoreFocusOut: true,
          validateInput: (v) =>
            jiraOrigin(v) ? undefined : "Enter a valid Jira URL",
        });
        const origin = input ? jiraOrigin(input) : "";
        if (!origin) return;
        await vscode.workspace
          .getConfiguration(CFG)
          .update("jiraBaseUrl", origin, vscode.ConfigurationTarget.Global);
        const ticket = String(m.ticket ?? "");
        if (/^[A-Za-z0-9_-]{1,64}$/.test(ticket))
          vscode.env.openExternal(
            vscode.Uri.parse(`${origin}/browse/${encodeURIComponent(ticket)}`),
          );
        break;
      }
      case "open": {
        // Only https links (PRs, check runs, Jira) are handed to the browser.
        if (isHttpsUrl(m.url)) vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      }
      case "toggleFavorite": {
        const repo = m.repo;
        if (!isRepo(repo)) return;
        const cfg = vscode.workspace.getConfiguration(CFG);
        const favs = new Set(cfg.get<string[]>("favoriteRepos", []));
        if (favs.has(repo)) favs.delete(repo);
        else favs.add(repo);
        await cfg.update(
          "favoriteRepos",
          [...favs].sort(),
          vscode.ConfigurationTarget.Global,
        );
        break;
      }
      case "addAccount":
        await this.addAccount();
        break;
      case "signIn":
        await this.signIn();
        break;
      case "openSettings":
        vscode.commands.executeCommand("prStatus.openSettings");
        break;
    }
  }

  /** Keeps only known UI keys with valid values from a webview message. */
  private validPatch(raw: unknown): Partial<UiState> {
    const p = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const out: Partial<UiState> = {};
    if (
      typeof p.accountKey === "string" &&
      this.accounts.some((a) => a.key === p.accountKey)
    )
      out.accountKey = p.accountKey;
    if (
      p.author === "@me" ||
      p.author === "@team" ||
      p.author === "@other" ||
      isLogin(p.author)
    )
      out.author = p.author as string;
    if (p.repo === "*" || isRepo(p.repo)) out.repo = p.repo as string;
    if (SHOW_MODES.includes(p.show as ShowMode)) out.show = p.show as ShowMode;
    if (SORT_MODES.includes(p.sort as SortMode)) out.sort = p.sort as SortMode;
    if (typeof p.drafts === "boolean") out.drafts = p.drafts;
    if (typeof p.addDescription === "boolean")
      out.addDescription = p.addDescription;
    return out;
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
   * Copies PR links (optionally with titles) for an approval request.
   * The webview sends PR ids in display order; only known PRs that still need
   * approval are used, and the text is built here from our own data.
   */
  private async copyLinks(rawIds: unknown, withDescription: boolean): Promise<void> {
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((v): v is string => typeof v === "string")
      : [];
    const byId = new Map(this.prs.map((p) => [p.id, p]));
    const prs = ids
      .map((id) => byId.get(id))
      .filter(
        (p): p is PrView =>
          !!p &&
          p.approvals.approved < p.approvals.required &&
          !p.inMergeQueue &&
          isHttpsUrl(p.url),
      );
    if (!prs.length) {
      vscode.window.showInformationMessage(
        "PR Status: no PRs waiting for approval in this list.",
      );
      return;
    }
    const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
    const text = withDescription
      ? prs.map((p) => `${oneLine(p.title)}\n${p.url}`).join("\n\n")
      : prs.map((p) => p.url).join("\n");
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
      `PR Status: copied ${prs.length} PR link${prs.length === 1 ? "" : "s"}${withDescription ? " with descriptions" : ""}.`,
    );
  }

  /** Re-run failed jobs (or all jobs) of the GitHub Actions runs behind a PR's checks. */
  private async rerun(prId: string, failedOnly: boolean): Promise<void> {
    const pr = this.prs.find((p) => p.id === prId);
    if (!pr) return;
    // Only offered when something failed (the buttons are disabled otherwise).
    if (pr.checks.failed === 0) return;
    const runIds = failedOnly ? pr.rerun.failedRunIds : pr.rerun.allRunIds;
    if (!runIds.length) {
      vscode.window.showWarningMessage(
        `PR Status: the failing checks on #${pr.number} are not GitHub Actions workflows, so they can't be re-run from here.`,
      );
      return;
    }
    const what = failedOnly
      ? `the failed jobs in ${runIds.length} workflow run(s)`
      : `all jobs in ${runIds.length} workflow run(s)`;
    const choice = await vscode.window.showWarningMessage(
      `Re-run ${what} for ${pr.repo}#${pr.number}?`,
      { modal: true, detail: pr.title },
      failedOnly ? "Re-run failed" : "Re-run all",
    );
    if (!choice) return;

    const target = await this.api();
    if (!target) {
      vscode.window.showErrorMessage("PR Status: sign in to GitHub first.");
      return;
    }
    const errors: string[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Re-running checks for #${pr.number}…`,
      },
      async () => {
        for (const id of runIds) {
          try {
            await rerunWorkflowRun(target.api, pr.repo, id, failedOnly);
          } catch (e) {
            errors.push(`run ${id}: ${(e as Error).message}`);
          }
        }
      },
    );
    const ok = runIds.length - errors.length;
    if (errors.length) {
      vscode.window.showErrorMessage(
        `PR Status: ${ok} of ${runIds.length} run(s) restarted. ${errors.join("; ")}`,
      );
    } else {
      vscode.window.showInformationMessage(
        `PR Status: restarted ${ok} workflow run(s) for #${pr.number}.` +
          (pr.rerun.failedExternal
            ? ` ${pr.rerun.failedExternal} failing non-Actions check(s) were skipped.`
            : ""),
      );
    }
    // Give GitHub a moment to queue the jobs, then refresh.
    setTimeout(() => this.refresh(true), 5000);
  }

  // ---------- State ----------

  private get ui(): UiState {
    const stored = this.context.globalState.get<Record<string, unknown>>(
      "ui",
      {},
    );
    const valid = this.validPatch(stored);
    if (valid.author === "@other") delete valid.author;
    // accountKey is only used as a lookup key; keep it even before accounts load.
    if (typeof stored.accountKey === "string")
      valid.accountKey = stored.accountKey;
    return { ...DEFAULT_UI, ...valid };
  }

  private async setUi(patch: Partial<UiState>): Promise<void> {
    await this.context.globalState.update("ui", { ...this.ui, ...patch });
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration(CFG);
    return {
      refreshIntervalSeconds: Math.max(
        15,
        c.get<number>("refreshIntervalSeconds", 60),
      ),
      organizations: logins(c.get<unknown>("organizations", [])),
      favoriteRepos: repos(c.get<unknown>("favoriteRepos", [])),
      teamMembers: logins(c.get<unknown>("teamMembers", [])),
      requiredApprovals: c.get<number>("requiredApprovals", 1),
      requiredApprovalsPerRepo: c.get<Record<string, number>>(
        "requiredApprovalsPerRepo",
        {},
      ),
      ticketPattern: c.get<string>("ticketPattern", "[A-Z][A-Z0-9]+-\\d+"),
      jiraBaseUrl: c.get<string>("jiraBaseUrl", ""),
      ignoredChecks: c.get<string[]>("ignoredChecks", []),
      ignoreBotThreads: c.get<boolean>("ignoreBotThreads", false),
      groupByRepo: c.get<boolean>("groupByRepo", false),
      compact: c.get<boolean>("compact", false),
      enterpriseUri: enterpriseUri(),
    };
  }

  /** Settings that affect what is fetched (everything except favorites). */
  private settingsSnapshot(): string {
    const { favoriteRepos: _ignored, ...rest } = this.cfg();
    void _ignored;
    return JSON.stringify(rest);
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.view?.visible && vscode.window.state.focused)
        this.refresh(false);
    }, this.cfg().refreshIntervalSeconds * 1000);
  }

  private isStale(): boolean {
    return (
      Date.now() - this.lastRefresh > this.cfg().refreshIntervalSeconds * 1000
    );
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
        const accts = await vscode.authentication.getAccounts(providerId);
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
            await vscode.window.showQuickPick(
              [
                { label: "github.com", id: "github" },
                { label: "GitHub Enterprise", id: "github-enterprise" },
              ],
              { placeHolder: "Which GitHub?" },
            )
          )?.id
        : "github";
    if (!providerId) return;
    try {
      const session = await vscode.authentication.getSession(
        providerId,
        SCOPES,
        { clearSessionPreference: true, createIfNone: true },
      );
      await this.setUi({ accountKey: `${providerId}:${session.account.id}` });
      this.refresh(true);
    } catch (e) {
      vscode.window.showErrorMessage(
        `PR Status: sign-in failed: ${(e as Error).message}`,
      );
    }
  }

  private async signIn(): Promise<void> {
    const acct = this.currentAccount();
    try {
      const session = await vscode.authentication.getSession(
        acct?.providerId ?? "github",
        SCOPES,
        {
          createIfNone: true,
          account: acct?.account,
        },
      );
      await this.setUi({
        accountKey: `${acct?.providerId ?? "github"}:${session.account.id}`,
      });
      this.refresh(true);
    } catch (e) {
      vscode.window.showErrorMessage(
        `PR Status: sign-in failed: ${(e as Error).message}`,
      );
    }
  }

  private currentAccount(): AccountOption | undefined {
    const key = this.ui.accountKey;
    return this.accounts.find((a) => a.key === key) ?? this.accounts[0];
  }

  private async api(): Promise<{ api: ApiTarget; key: string } | undefined> {
    const acct = this.currentAccount();
    if (!acct) return undefined;
    const session = await vscode.authentication.getSession(
      acct.providerId,
      SCOPES,
      { account: acct.account, silent: true },
    );
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
    const key = `${repo}@${pr.baseRefName}`;
    let cached = this.approvalsCache.get(key);
    if (!cached || Date.now() - cached.at > 3_600_000) {
      cached = {
        at: Date.now(),
        value: await getRulesetRequiredApprovals(api, repo, pr.baseRefName),
      };
      this.approvalsCache.set(key, cached);
    }
    return (
      cached.value ??
      pr.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ??
      cfg.requiredApprovals
    );
  }

  private repoListFor(key: string): string[] {
    return this.repoCache.get(key)?.repos ?? [];
  }

  private async repos(api: ApiTarget, key: string): Promise<string[]> {
    const cached = this.repoCache.get(key);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.repos;
    try {
      const repos = await listViewerRepos(api);
      this.repoCache.set(key, { at: Date.now(), repos });
      return repos;
    } catch {
      return cached?.repos ?? [];
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
    void this.view.webview.postMessage({
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
      },
    });
  }
}
