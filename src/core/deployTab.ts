// The Deployments tab: its state, refresh, and the AWS actions (pick a profile, sign in).

import { listProfiles } from "./awsCli";
import { awsConfig, awsLoginCommand, ignoredStages, PanelConfig, pipelinePrefix } from "./config";
import type { DeployUi } from "./deployFilters";
import { AwsStatus, DeployPr, DeployService } from "./deployService";
import type { Connection } from "./githubAuth";
import { summarize } from "./deploySummary";
import { LatestWins } from "./latestWins";
import type { HostUi, Settings } from "./ports";
import type { DeployPayload } from "./protocol";

interface DeployTabDeps {
  /** Signed-in GitHub, or undefined when signed out. */
  github: () => Promise<Connection | undefined>;
  ui: () => DeployUi;
  config: () => PanelConfig;
  settings: Settings;
  hostUi: HostUi;
  changed: () => void;
  service?: DeployService;
  /** AWS CLI profile names (never credentials). */
  profiles?: (cliPath: string) => Promise<string[]>;
  now?: () => number;
}

interface DeployState {
  prs: DeployPr[];
  error?: string;
  hint?: string;
  aws: AwsStatus;
  updatedAt?: number;
}

export class DeployTab {
  private state: DeployState = { prs: [], aws: { state: "ok" } };
  private readonly refresher: LatestWins;
  private readonly service: DeployService;

  constructor(private readonly deps: DeployTabDeps) {
    this.refresher = new LatestWins(deps.changed);
    this.service = deps.service ?? new DeployService();
  }

  get loading(): boolean {
    return this.refresher.loading;
  }

  get updatedAt(): number {
    return this.state.updatedAt ?? 0;
  }

  refresh(force: boolean): Promise<void> {
    return this.refresher.run(
      force,
      async (isCurrent) => {
        const patch = await this.load();
        if (isCurrent()) Object.assign(this.state, patch);
      },
      (e) => (this.state.error = e.message),
    );
  }

  /** Called when a filter changes: drop the old list before loading. */
  reload(): Promise<void> {
    this.state.prs = [];
    return this.refresh(true);
  }

  payload(): DeployPayload {
    return {
      ...this.state,
      ...summarize(this.state.prs, this.deps.ui().deployStage),
      loading: this.loading,
      profile: awsConfig(this.deps.settings)?.profile ?? "",
      canSignIn: !!awsLoginCommand(this.deps.settings),
    };
  }

  /** Lets the user pick one of the AWS CLI's profiles (names only) and saves it in user settings. */
  async pickProfile(): Promise<void> {
    const cliPath = awsConfig(this.deps.settings)?.cliPath ?? "aws";
    const profiles = await (this.deps.profiles ?? listProfiles)(cliPath);
    if (!profiles.length)
      return this.deps.hostUi.warn("PR Status: the AWS CLI has no profiles yet. Sign in to AWS first, then pick a profile.");
    const pick = await this.deps.hostUi.pick(
      profiles.map((label) => ({ label })),
      "AWS profile for reading CodePipeline (the account that owns the pipelines)",
    );
    if (pick) await this.deps.settings.update("aws.profile", pick.label);
  }

  /** Runs the user's own sign-in command (user setting) in a terminal, or opens that setting. */
  signIn(): void {
    const cmd = awsLoginCommand(this.deps.settings);
    if (!cmd) return this.deps.hostUi.openSettings("prStatus.aws.loginCommand");
    this.deps.hostUi.runInTerminal("AWS sign-in", cmd);
    this.deps.hostUi.info("PR Status: finish the AWS sign-in in the terminal, then press Refresh in the panel.");
  }

  private async load(): Promise<Partial<DeployState>> {
    const gh = await this.deps.github();
    if (!gh) return { prs: [], error: undefined, hint: undefined };
    const cfg = this.deps.config();
    const settings = this.deps.settings;
    const result = await this.service.load({
      ui: this.deps.ui(),
      api: gh.api,
      search: {
        viewer: gh.viewer,
        team: cfg.teamMembers,
        organizations: cfg.organizations,
        favoriteRepos: cfg.favoriteRepos,
      },
      ticketPattern: cfg.ticketPattern,
      jiraBaseUrl: cfg.jiraBaseUrl,
      aws: awsConfig(settings),
      pipelinePrefix: (repo) => pipelinePrefix(settings, repo),
      ignoreStages: ignoredStages(settings),
    });
    return { ...result, error: undefined, updatedAt: (this.deps.now ?? Date.now)() };
  }
}
