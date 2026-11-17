// Reads and checks the extension's settings. Anything that runs a program, picks an account or decides where
// the GitHub token goes is read from the user level only (see Settings.user).

import type { AwsConfig } from "./awsCli";
import type { Settings } from "./ports";
import { isHttpsUrl, logins, repos, safeRegex } from "./validate";

export interface PanelConfig {
  refreshIntervalSeconds: number;
  organizations: string[];
  favoriteRepos: string[];
  teamMembers: string[];
  requiredApprovals: number;
  requiredApprovalsPerRepo: Record<string, number>;
  ticketPattern: string;
  jiraBaseUrl: string;
  ignoredChecks: string[];
  ignoreBotThreads: boolean;
  groupByRepo: boolean;
  compact: boolean;
  /** GitHub Enterprise server, "" when not set up. */
  enterpriseUri: string;
}

/**
 * GitHub Enterprise Server URL from VS Code's own "github-enterprise.uri" setting (the server VS Code's GitHub
 * Enterprise sign-in uses), user level only so a workspace can never redirect the token. "" unless https.
 */
function enterpriseUri(s: Settings): string {
  const v = s.user<unknown>("uri", undefined, "github-enterprise");
  return isHttpsUrl(v) ? v : "";
}

export function readConfig(s: Settings): PanelConfig {
  return {
    refreshIntervalSeconds: Math.max(15, s.get("refreshIntervalSeconds", 60)),
    organizations: logins(s.get<unknown>("organizations", [])),
    favoriteRepos: repos(s.get<unknown>("favoriteRepos", [])),
    teamMembers: logins(s.get<unknown>("teamMembers", [])),
    requiredApprovals: s.get("requiredApprovals", 1),
    requiredApprovalsPerRepo: s.get<Record<string, number>>("requiredApprovalsPerRepo", {}),
    ticketPattern: s.get("ticketPattern", "[A-Z][A-Z0-9]+-\\d+"),
    jiraBaseUrl: s.get("jiraBaseUrl", ""),
    ignoredChecks: s.get<string[]>("ignoredChecks", []),
    ignoreBotThreads: s.get("ignoreBotThreads", false),
    groupByRepo: s.get("groupByRepo", false),
    compact: s.get("compact", false),
    enterpriseUri: enterpriseUri(s),
  };
}

/** Settings that affect what is fetched (everything except favorites), to tell real changes apart. */
export function fetchSnapshot(cfg: PanelConfig): string {
  const { favoriteRepos: _ignored, ...rest } = cfg;
  void _ignored;
  return JSON.stringify(rest);
}

const text = (s: Settings, key: string, fallback: string): string => String(s.user(key, fallback)).trim();

/** How to call the AWS CLI (user settings only); undefined when AWS is off or a value is not safe to pass. */
export function awsConfig(s: Settings): AwsConfig | undefined {
  if (!s.user("aws.enabled", true)) return undefined;
  const cliPath = text(s, "aws.cliPath", "aws") || "aws";
  const profile = text(s, "aws.profile", "");
  const region = text(s, "aws.region", "us-east-1") || "us-east-1";
  const safe =
    /^[\w./~ -]{1,200}$/.test(cliPath) && /^[\w.@+-]{0,128}$/.test(profile) && /^[a-z0-9-]{1,30}$/.test(region);
  return safe ? { cliPath, profile, region } : undefined;
}

/** CodePipeline name prefix for a repo: its setting, or the repo name and a dash. */
export function pipelinePrefix(s: Settings, repo: string): string {
  const v = s.user<Record<string, unknown>>("aws.pipelinePrefixes", {})[repo];
  return typeof v === "string" && v.trim() ? v.trim() : `${repo.split("/")[1]}-`;
}

/** Pipeline stages to hide. */
export function ignoredStages(s: Settings): RegExp | undefined {
  const src = String(s.user("aws.ignoreStages", "^source$"));
  return src ? safeRegex(src, "i") : undefined;
}

/** The user's own AWS sign-in command line, "" when not set. */
export function awsLoginCommand(s: Settings): string {
  return text(s, "aws.loginCommand", "");
}
