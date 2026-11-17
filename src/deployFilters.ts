// Deployments tab filters: the stored UI state and the GitHub searches it turns into.

import { parsePrRef, ticketKeyIn } from "./ticketLinks";
import { isLogin, isRepo } from "./validate";

const TABS = ["prs", "deploy"] as const;
const STATES = ["all", "open", "merged"] as const;
const WHEN = [7, 14, 30, 90, 180, 365];

/** Deployments tab part of the stored UI state, plus which tab is showing. */
export interface DeployUi {
  tab: (typeof TABS)[number];
  /** "@me" | "@team" | "@anyone" | a GitHub login */
  deployWho: string;
  /** Days back: open PRs updated, or PRs merged, in this window. */
  deployWhen: number;
  deployState: (typeof STATES)[number];
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
  tab: (v) => TABS.includes(v as DeployUi["tab"]),
  deployWho: isWho,
  deployWhen: (v) => WHEN.includes(v as number),
  deployState: (v) => STATES.includes(v as DeployUi["deployState"]),
  deployRepo: (v) => v === "*" || isRepo(v),
  deployBranch: (v) => typeof v === "string" && BRANCH_RE.test(v),
  deployFind: (v) => typeof v === "string" && v.length <= 300,
  deployStage: (v) => typeof v === "string" && v.length <= 100,
};

/** Keeps only valid Deployments UI keys from a webview message or stored state. */
export function deployPatch(p: Record<string, unknown>): Partial<DeployUi> {
  const out: Record<string, unknown> = {};
  for (const [k, ok] of Object.entries(VALID)) {
    const v = typeof p[k] === "string" && k !== "deployStage" ? (p[k] as string).trim() : p[k];
    if (v !== undefined && ok(v)) out[k] = v;
  }
  return out as Partial<DeployUi>;
}

export interface SearchContext {
  viewer: string;
  team: string[];
  organizations: string[];
  favoriteRepos: string[];
}

/** What to fetch: one PR, a set of searches, or a hint about what is missing. */
export type FetchPlan =
  | { pr: { repo: string; number: number } }
  | { queries: string[] }
  | { hint: string };

function scope(ui: DeployUi, ctx: SearchContext): string {
  if (ui.deployRepo !== "*") return `repo:${ui.deployRepo}`;
  if (ctx.organizations.length)
    return ctx.organizations.map((o) => `org:${o}`).join(" ");
  return ctx.favoriteRepos.map((r) => `repo:${r}`).join(" ");
}

function authors(ui: DeployUi, ctx: SearchContext): string[] {
  if (ui.deployWho === "@me") return [`author:${ctx.viewer}`];
  if (ui.deployWho === "@team") return ctx.team.map((m) => `author:${m}`);
  return ui.deployWho === "@anyone" ? [""] : [`author:${ui.deployWho}`];
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
  const where = scope(ui, ctx);
  const found = findPlan(ui, where);
  if (found) return found;
  const who = authors(ui, ctx);
  if (!who.length) return { hint: "No team yet: add GitHub usernames to PR Status › Team Members." };
  if (who.includes("") && !where) return { hint: "Pick a repo (or set PR Status › Organizations) to list everyone's PRs." };
  const text = ui.deployFind ? `"${ui.deployFind.replace(/["\\]/g, "").slice(0, 100)}" in:title` : "";
  const queries = who.flatMap((a) => stateParts(ui).map((s) => `is:pr archived:false ${s} ${a} ${text} ${where}`));
  return { queries: queries.map((q) => q.replace(/\s+/g, " ").trim()) };
}
