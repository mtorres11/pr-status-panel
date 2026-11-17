// The Deployments tab on the extension side: state, webview messages, AWS settings and refresh.
// The panel provider owns GitHub sign-in and posting; this class asks it through DeployHost.

import * as vscode from "vscode";
import { AwsConfig, listProfiles } from "./awsCli";
import { DeployUi } from "./deployFilters";
import { AwsStatus, DeployPr, DeployService } from "./deployService";
import type { ApiTarget } from "./github";
import { CFG, userSetting } from "./userSettings";
import { safeRegex } from "./validate";

export interface DeployHost {
  /** Signed-in GitHub API and login, or undefined when signed out. */
  github(): Promise<{ api: ApiTarget; viewer: string } | undefined>;
  ui(): DeployUi;
  post(): void;
  settings(): {
    teamMembers: string[];
    organizations: string[];
    favoriteRepos: string[];
    ticketPattern: string;
    jiraBaseUrl: string;
  };
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

  /** Handles a Deployments message from the webview; false when it is not one of ours. */
  async handle(m: { type: string }): Promise<boolean> {
    if (m.type === "awsProfile") await this.pickProfile();
    else if (m.type === "awsSignIn") await this.signIn();
    else return false;
    return true;
  }

  private awsConfig(): AwsConfig | undefined {
    if (!userSetting("aws.enabled", true)) return undefined;
    const cliPath = String(userSetting("aws.cliPath", "aws")).trim() || "aws";
    const profile = String(userSetting("aws.profile", "")).trim();
    const region =
      String(userSetting("aws.region", "us-east-1")).trim() || "us-east-1";
    if (
      !/^[\w./~ -]{1,200}$/.test(cliPath) ||
      !/^[\w.@+-]{0,128}$/.test(profile) ||
      !/^[a-z0-9-]{1,30}$/.test(region)
    )
      return undefined;
    return { cliPath, profile, region };
  }

  private pipelinePrefix(repo: string): string {
    const map = userSetting<Record<string, unknown>>(
      "aws.pipelinePrefixes",
      {},
    );
    const v = map[repo];
    return typeof v === "string" && v.trim()
      ? v.trim()
      : `${repo.split("/")[1]}-`;
  }

  private ignoreStages(): RegExp | undefined {
    const src = String(userSetting("aws.ignoreStages", "^source$"));
    return src ? safeRegex(src, "i") : undefined;
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
    const s = this.host.settings();
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
      aws: this.awsConfig(),
      pipelinePrefix: (repo) => this.pipelinePrefix(repo),
      ignoreStages: this.ignoreStages(),
    });
    return { ...result, error: undefined, updatedAt: Date.now() };
  }

  payload(): object {
    return {
      ...this.state,
      profile: this.awsConfig()?.profile ?? "",
      canSignIn: !!String(userSetting("aws.loginCommand", "")).trim(),
    };
  }

  /** Lets the user pick one of the AWS CLI's profiles (names only) and saves it in user settings. */
  private async pickProfile(): Promise<void> {
    const cliPath = this.awsConfig()?.cliPath ?? "aws";
    const profiles = await listProfiles(cliPath);
    if (!profiles.length) {
      vscode.window.showWarningMessage(
        "PR Status: the AWS CLI has no profiles yet. Sign in to AWS first, then pick a profile.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(profiles, {
      placeHolder:
        "AWS profile for reading CodePipeline (the account that owns the pipelines)",
    });
    if (!pick) return;
    await vscode.workspace
      .getConfiguration(CFG)
      .update("aws.profile", pick, vscode.ConfigurationTarget.Global);
  }

  /** Runs the user's own sign-in command (user setting) in a terminal. */
  private async signIn(): Promise<void> {
    const cmd = String(userSetting("aws.loginCommand", "")).trim();
    if (!cmd) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "prStatus.aws.loginCommand",
      );
      return;
    }
    const terminal = vscode.window.createTerminal({ name: "AWS sign-in" });
    terminal.show();
    terminal.sendText(cmd);
    vscode.window.showInformationMessage(
      "PR Status: finish the AWS sign-in in the terminal, then press Refresh in the panel.",
    );
  }
}
