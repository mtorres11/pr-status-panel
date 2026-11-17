// The Deployments tab on the extension side: state, its webview actions, AWS settings and refresh.
// The panel owns GitHub sign-in and posting; this class asks it through DeployHost.

import { listProfiles } from "./awsCli";
import { awsConfig, awsLoginCommand, ignoredStages, pipelinePrefix } from "./config";
import { DeployUi } from "./deployFilters";
import { AwsStatus, DeployPr, DeployService } from "./deployService";
import type { ApiTarget } from "./github";
import type { HostUi, Settings } from "./ports";
import type { DeployPayload } from "./protocol";

export interface DeployHost {
  /** Signed-in GitHub API and login, or undefined when signed out. */
  github(): Promise<{ api: ApiTarget; viewer: string } | undefined>;
  ui(): DeployUi;
  post(): void;
  config(): {
    teamMembers: string[];
    organizations: string[];
    favoriteRepos: string[];
    ticketPattern: string;
    jiraBaseUrl: string;
  };
  settings: Settings;
  hostUi: HostUi;
}

interface DeployState {
  prs: DeployPr[];
  loading: boolean;
  error?: string;
  hint?: string;
  aws: AwsStatus;
  updatedAt?: number;
}

export class DeployPanel {
  private readonly service = new DeployService();
  private state: DeployState = {
    prs: [],
    loading: false,
    aws: { state: "ok" },
  };
  private generation = 0;

  constructor(private readonly host: DeployHost) {}

  get loading(): boolean {
    return this.state.loading;
  }

  get updatedAt(): number {
    return this.state.updatedAt ?? 0;
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    this.state.loading = true;
    this.host.post();
    let patch: Partial<DeployState>;
    try {
      patch = await this.load();
    } catch (e) {
      patch = { error: (e as Error).message };
    }
    if (gen !== this.generation) return;
    Object.assign(this.state, { loading: false, ...patch });
    this.host.post();
  }

  /** Called when a filter changes: drop the old list before loading. */
  async reload(): Promise<void> {
    this.state.prs = [];
    await this.refresh();
  }

  private async load(): Promise<Partial<DeployState>> {
    const gh = await this.host.github();
    if (!gh) return { prs: [], error: undefined, hint: undefined };
    const s = this.host.config();
    const settings = this.host.settings;
    const result = await this.service.load({
      ui: this.host.ui(),
      api: gh.api,
      search: {
        viewer: gh.viewer,
        team: s.teamMembers,
        organizations: s.organizations,
        favoriteRepos: s.favoriteRepos,
      },
      ticketPattern: s.ticketPattern,
      jiraBaseUrl: s.jiraBaseUrl,
      aws: awsConfig(settings),
      pipelinePrefix: (repo) => pipelinePrefix(settings, repo),
      ignoreStages: ignoredStages(settings),
    });
    return { ...result, error: undefined, updatedAt: Date.now() };
  }

  payload(): DeployPayload {
    return {
      ...this.state,
      profile: awsConfig(this.host.settings)?.profile ?? "",
      canSignIn: !!awsLoginCommand(this.host.settings),
    };
  }

  /** Lets the user pick one of the AWS CLI's profiles (names only) and saves it in user settings. */
  async pickProfile(): Promise<void> {
    const cliPath = awsConfig(this.host.settings)?.cliPath ?? "aws";
    const profiles = await listProfiles(cliPath);
    if (!profiles.length) {
      this.host.hostUi.warn(
        "PR Status: the AWS CLI has no profiles yet. Sign in to AWS first, then pick a profile.",
      );
      return;
    }
    const pick = await this.host.hostUi.pick(
      profiles.map((label) => ({ label })),
      "AWS profile for reading CodePipeline (the account that owns the pipelines)",
    );
    if (pick) await this.host.settings.update("aws.profile", pick.label);
  }

  /** Runs the user's own sign-in command (user setting) in a terminal. */
  signIn(): void {
    const cmd = awsLoginCommand(this.host.settings);
    if (!cmd) {
      this.host.hostUi.openSettings("prStatus.aws.loginCommand");
      return;
    }
    this.host.hostUi.runInTerminal("AWS sign-in", cmd);
    this.host.hostUi.info("PR Status: finish the AWS sign-in in the terminal, then press Refresh in the panel.");
  }
}
