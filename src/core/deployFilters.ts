// Deployments tab filters: the stored UI state and the GitHub searches it turns into.

import { loginsFor, repoScope } from "./searchScope";
import { parsePrRef, ticketKeyIn } from "./ticketLinks";
import { isLogin, isRepo, oneOf, pickValid } from "./validate";

const TABS = ["prs", "deploy"] as const;

/** "When" choices: days back. */
export const WHEN_OPTIONS = [
  [7, "Last 7 days"],
  [14, "Last 14 days"],
  [30, "Last 30 days"],
  [90, "Last 90 days"],
  [180, "Last 6 months"],
  [365, "Last 1 year"],
] as const;

/** "Show" choices: which PR states. */
export const STATE_OPTIONS = [
  ["all", "Open + merged"],
  ["open", "Open only"],
  ["merged", "Merged only"],
] as const;

/** Deployments tab part of the stored UI state, plus which tab is showing. */
export interface DeployUi {
  tab: (typeof TABS)[number];
  /** "@me" | "@team" | "@anyone" | a GitHub login */
  deployWho: string;
  /** Days back: open PRs updated, or PRs merged, in this window. */
  deployWhen: number;
  deployState: (typeof STATE_OPTIONS)[number][0];
  /** "*" or owner/name */
  deployRepo: string;
  /** Branch the "in branch" check uses. */
  deployBranch: string;
  /** PR number/link or ticket key; overrides the other filters. */
  deployFind: string;
  /** Where-it-is filter, applied in the panel only. */
  deployStage: string;
}

/** Keys that only change how the list is drawn, not what is fetched. */
export const DISPLAY_ONLY_KEYS = ["deployStage"];

export const DEFAULT_DEPLOY_UI: DeployUi = {
  tab: "prs",
  deployWho: "@me",
  deployWhen: 30,
  deployState: "all",
  deployRepo: "*",
  deployBranch: "main",
  deployFind: "",
  deployStage: "",
};

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const isWho = (v: unknown) =>
  v === "@me" || v === "@team" || v === "@anyone" || isLogin(v);

const VALID: Record<keyof DeployUi, (v: unknown) => boolean> = {
  tab: oneOf(TABS),
  deployWho: isWho,
  deployWhen: oneOf(WHEN_OPTIONS.map(([v]) => v)),
  deployState: oneOf(STATE_OPTIONS.map(([v]) => v)),
  deployRepo: (v) => v === "*" || isRepo(v),
  deployBranch: (v) => typeof v === "string" && BRANCH_RE.test(v),
  deployFind: (v) => typeof v === "string" && v.length <= 300,
  deployStage: (v) => typeof v === "string" && v.length <= 100,
};

/** Keeps only valid Deployments UI keys from a webview message or stored state. */
export function deployPatch(p: Record<string, unknown>): Partial<DeployUi> {
  return pickValid<DeployUi>(p, VALID, (k, v) => (typeof v === "string" && k !== "deployStage" ? v.trim() : v));
}

export interface SearchContext {
  viewer: string;
  team: string[];
  organizations: string[];
  favoriteRepos: string[];
}

/** What to fetch: one PR, a set of searches, or a hint about what is missing. */
type FetchPlan =
  | { pr: { repo: string; number: number } }
  | { queries: string[] }
  | { hint: string };

/** Author qualifiers; "@anyone" is one search without one. */
function authors(ui: DeployUi, ctx: SearchContext): string[] {
  if (ui.deployWho === "@anyone") return [""];
  return loginsFor(ui.deployWho, ctx.viewer, ctx.team).map((m) => `author:${m}`);
}

function sinceDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Open PRs updated, and PRs merged, within the window (per the state filter). */
function stateParts(ui: DeployUi): string[] {
  const d = sinceDate(ui.deployWhen);
  const open = `is:open updated:>=${d}`;
  const merged = `is:merged merged:>=${d}`;
  return ui.deployState === "open"
    ? [open]
    : ui.deployState === "merged"
      ? [merged]
      : [open, merged];
}

/** Find box: a PR reference fetches that PR; a ticket key lists every PR for it. Undefined = plain filters. */
function findPlan(ui: DeployUi, where: string): FetchPlan | undefined {
  const find = ui.deployFind;
  if (!find) return undefined;
  const pr = parsePrRef(find, ui.deployRepo !== "*" ? ui.deployRepo : undefined);
  if (pr) return { pr };
  if (!where) return { hint: "Set PR Status › Organizations or star a favorite repo, or pick a repo, to search." };
  const ticket = ticketKeyIn(find);
  return ticket ? { queries: [`is:pr archived:false "${ticket}" in:title ${where}`] } : undefined;
}

export function fetchPlan(ui: DeployUi, ctx: SearchContext): FetchPlan {
  const where = repoScope(ui.deployRepo, ctx.organizations, ctx.favoriteRepos);
  const found = findPlan(ui, where);
  if (found) return found;
  const who = authors(ui, ctx);
  if (!who.length) return { hint: "No team yet: add GitHub usernames to PR Status › Team Members." };
  if (who.includes("") && !where) return { hint: "Pick a repo (or set PR Status › Organizations) to list everyone's PRs." };
  const text = ui.deployFind ? `"${ui.deployFind.replace(/["\\]/g, "").slice(0, 100)}" in:title` : "";
  const queries = who.flatMap((a) => stateParts(ui).map((s) => `is:pr archived:false ${s} ${a} ${text} ${where}`));
  return { queries: queries.map((q) => q.replace(/\s+/g, " ").trim()) };
}
