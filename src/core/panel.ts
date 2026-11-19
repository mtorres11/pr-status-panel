// The panel: both tabs, the UI state, sign-in and the webview messages, wired together. The editor side
// (host-vscode) only forwards events and messages here and draws what `post` sends.

import { fetchSnapshot, PanelConfig, readConfig } from "./config";
import { DISPLAY_ONLY_KEYS } from "./deployFilters";
import type { DeployService } from "./deployService";
import { DeployTab } from "./deployTab";
import { GitHubAuth } from "./githubAuth";
import { gitHubPrClient, PrClient } from "./githubPrs";
import type { Auth, HostUi, KeyValueStore, PanelView, Settings } from "./ports";
import { PrActions } from "./prActions";
import { PrTab } from "./prTab";
import { About, MessageHandlers, Payload, routeMessage } from "./protocol";
import { messageHandlers } from "./router";
import { UI_OPTIONS, UiStateStore, validPatch } from "./uiState";
import { isLogin } from "./validate";

/** UI keys that only change how the list is drawn. */
const DISPLAY_ONLY = ["copyGroup", "copyFormat", ...DISPLAY_ONLY_KEYS];

interface PanelDeps {
  ui: HostUi;
  settings: Settings;
  auth: Auth;
  store: KeyValueStore;
  about: About;
  client?: PrClient;
  deployService?: DeployService;
  now?: () => number;
}

export class Panel {
  private view?: PanelView;
  private readonly uiState: UiStateStore;
  private readonly github: GitHubAuth;
  private readonly prTab: PrTab;
  private readonly deployTab: DeployTab;
  private readonly handlers: MessageHandlers;
  private lastSettings: string;
  private readonly now: () => number;

  constructor(private readonly deps: PanelDeps) {
    this.now = deps.now ?? Date.now;
    this.uiState = new UiStateStore(deps.store);
    const client = deps.client ?? gitHubPrClient();
    const config = () => this.config();
    const ui = () => this.uiState.get();
    const changed = () => this.post();
    this.github = new GitHubAuth({
      auth: deps.auth,
      ui: deps.ui,
      uiState: this.uiState,
      enterpriseUri: () => config().enterpriseUri,
      viewerLogin: (api) => client.viewerLogin(api),
    });
    this.prTab = new PrTab({ client, auth: this.github, config, ui, changed, now: this.now });
    const { settings, ui: hostUi, deployService: service, now } = deps;
    const github = () => this.github.connect();
    this.deployTab = new DeployTab({ github, ui, config, settings, hostUi, changed, service, now });
    const actions = new PrActions({
      ui: hostUi,
      settings,
      client,
      prs: this.prTab,
      github: async () => (await github())?.api,
      refreshSoon: (ms) => setTimeout(() => void this.refreshActive(true), ms),
    });
    this.handlers = messageHandlers({ panel: this, actions, deploy: this.deployTab, ui: hostUi });
    this.lastSettings = fetchSnapshot(config());
  }

  attach(view: PanelView): void {
    this.view = view;
  }

  detach(): void {
    this.view = undefined;
  }

  /** A raw message from the webview (untrusted); ignored once the view is gone. */
  async onMessage(raw: unknown): Promise<void> {
    if (this.view) await routeMessage(this.handlers, raw);
  }

  ready(): void {
    this.post();
    void this.refreshActive(true);
  }

  refresh(): Promise<void> {
    return this.refreshActive(true);
  }

  /** Refreshes the tab on screen; without `force`, not while it is already loading. */
  async refreshActive(force: boolean): Promise<void> {
    if (!this.view) return;
    const tab = this.uiState.get().tab === "deploy" ? this.deployTab : this.prTab;
    await tab.refresh(force);
  }

  /** Refreshes the tab on screen when it is older than the refresh interval. */
  refreshIfStale(): void {
    if (this.isStale()) void this.refreshActive(false);
  }

  get refreshIntervalMs(): number {
    return this.config().refreshIntervalSeconds * 1000;
  }

  /** Settings changed: true when it affects what is fetched (and a refresh started), false for display only. */
  settingsChanged(): boolean {
    const snapshot = fetchSnapshot(this.config());
    if (snapshot === this.lastSettings) {
      this.post(); // e.g. only favorites changed
      return false;
    }
    this.lastSettings = snapshot;
    void this.refreshActive(true);
    return true;
  }

  async signIn(another: boolean): Promise<void> {
    if (await this.github.signIn(another)) void this.refreshActive(true);
  }

  /** Applies a UI change from the webview; "Other user…" first asks for the login. */
  async setState(raw: Record<string, unknown>): Promise<void> {
    const patch = validPatch(raw, this.github.accounts.map((a) => a.key));
    if (patch.author === "@other") {
      const login = await this.askLogin();
      if (!login) return this.post();
      patch.author = login;
    }
    if (!Object.keys(patch).length) return this.post();
    await this.uiState.update(patch);
    await this.afterUiChange(Object.keys(patch));
  }

  private async askLogin(): Promise<string | undefined> {
    const clean = (v: string | undefined) => v?.trim().replace(/^@/, "");
    const login = await this.deps.ui.prompt({
      prompt: "GitHub username",
      placeHolder: "octocat",
      validate: (v) => (isLogin(clean(v)) ? undefined : "Not a valid GitHub username"),
    });
    const value = clean(login);
    return isLogin(value) ? value : undefined;
  }

  /** Fetches again only what a UI change affects. */
  private async afterUiChange(keys: string[]): Promise<void> {
    if (keys.every((k) => DISPLAY_ONLY.includes(k))) return this.post();
    if (keys.every((k) => k === "tab")) {
      this.post();
      if (this.isStale()) await this.refreshActive(true);
      return;
    }
    if (keys.some((k) => k.startsWith("deploy"))) return this.deployTab.reload();
    this.prTab.clear();
    await this.refreshActive(true);
  }

  /** The tab on screen has not been refreshed within the refresh interval. */
  private isStale(): boolean {
    const at = this.uiState.get().tab === "deploy" ? this.deployTab.updatedAt : this.prTab.lastRefresh;
    return this.now() - at > this.refreshIntervalMs;
  }

  private config(): PanelConfig {
    return readConfig(this.deps.settings);
  }

  private post(): void {
    this.view?.post({ type: "update", payload: this.payload() });
  }

  private payload(): Payload {
    const cfg = this.config();
    const acct = this.github.current();
    return {
      ui: { ...this.uiState.get(), accountKey: acct?.key },
      options: UI_OPTIONS,
      accounts: this.github.accounts.map(({ key, label }) => ({ key, label })),
      viewerLogin: this.github.viewer,
      team: cfg.teamMembers,
      favorites: cfg.favoriteRepos,
      ...this.prTab.view(acct?.key),
      needsSignIn: this.github.needsSignIn,
      compact: cfg.compact,
      groupByRepo: cfg.groupByRepo,
      about: this.deps.about,
      deploy: this.deployTab.payload(),
    };
  }
}
