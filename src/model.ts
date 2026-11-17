import { CopyGroup, copyGroupsOf } from "./copy";
import type { RawCheckContext, RawPullRequest } from "./githubPrs";
import { ticketsOf, ticketUrl } from "./ticketLinks";
import { MAX_REGEX_INPUT, safeRegex } from "./validate";

export type PrStatus =
  "failing" | "changes" | "running" | "waiting" | "ready" | "draft";

export interface CheckItem {
  name: string;
  state: "passed" | "failed" | "running" | "pending" | "skipped";
  url?: string;
  /** GitHub Actions workflow run id, when the check comes from Actions. */
  runId?: number;
}

/** An unresolved review thread, for the expandable list under the card. */
export interface ThreadItem {
  author: string;
  /** File and line the thread is on, e.g. "src/a.ts:12"; empty for a file-level thread. */
  where: string;
  /** Start of the first comment, plain text, cut to SNIPPET_MAX characters. */
  snippet: string;
  url?: string;
  outdated: boolean;
}

/** One reviewer, for the expandable approvals list. */
export interface ReviewerItem {
  name: string;
  state: "changes" | "requested" | "approved";
  url?: string;
}

const SNIPPET_MAX = 120;

export interface PrView {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  isDraft: boolean;
  /** Already queued to merge (GitHub merge queue). */
  inMergeQueue: boolean;
  ticket?: string;
  ticketUrl?: string;
  status: PrStatus;
  checks: {
    passed: number;
    failed: number;
    running: number;
    pending: number;
    skipped: number;
    total: number;
    items: CheckItem[];
  };
  threads: { resolved: number; total: number; items: ThreadItem[] };
  approvals: {
    approved: number;
    required: number;
    changesRequested: number;
    items: ReviewerItem[];
  };
  mergeable: string;
  /** Base branch name, e.g. "main". */
  baseRef: string;
  /** Head commit when last refreshed (guards the branch update). */
  headOid?: string;
  /** Behind its base and the viewer may update it. */
  canUpdateBranch: boolean;
  /** Can be updated and worth flagging: not a draft, not already in the merge queue. */
  behind: boolean;
  /** The "Copy links" groups this PR belongs to. */
  copyGroups: CopyGroup[];
  rerun: {
    /** Workflow runs with at least one failed check. */
    failedRunIds: number[];
    /** Every workflow run behind this PR's checks. */
    allRunIds: number[];
    /** Failed checks that are not GitHub Actions (cannot be re-run from here). */
    failedExternal: number;
  };
}

export interface ModelOptions {
  ticketPattern: string;
  jiraBaseUrl: string;
  ignoredChecks: string[];
  ignoreBotThreads: boolean;
}

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

/** Commit status states; anything else is still pending. */
const STATUS_STATES: Record<string, CheckItem["state"]> = { SUCCESS: "passed", FAILURE: "failed", ERROR: "failed" };

/** Display order of check states. */
const CHECK_ORDER: CheckItem["state"][] = ["failed", "running", "pending", "passed", "skipped"];

function checkState(c: RawCheckContext): CheckItem["state"] {
  if (c.__typename !== "CheckRun") return STATUS_STATES[c.state ?? ""] ?? "pending";
  if (c.status !== "COMPLETED") return c.status === "IN_PROGRESS" ? "running" : "pending";
  if (c.conclusion === "SKIPPED" || c.conclusion === "NEUTRAL") return "skipped";
  return c.conclusion && FAILED_CONCLUSIONS.has(c.conclusion) ? "failed" : "passed";
}

function checkItem(c: RawCheckContext): CheckItem {
  const run = c.__typename === "CheckRun";
  return {
    name: (run ? c.name : c.context) ?? "check",
    state: checkState(c),
    url: (run ? c.detailsUrl : c.targetUrl) ?? undefined,
    runId: run ? (c.checkSuite?.workflowRun?.databaseId ?? undefined) : undefined,
  };
}

/** The head commit's checks, minus ignored ones: counted per state and sorted for display. */
export function classifyChecks(pr: RawPullRequest, ignoredChecks: string[]): PrView["checks"] {
  const ignored = ignoredChecks.map((p) => safeRegex(p, "i")).filter((r): r is RegExp => !!r);
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const items = contexts
    .map(checkItem)
    .filter((i) => !ignored.some((r) => r.test(i.name.slice(0, MAX_REGEX_INPUT))))
    .sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const count = (s: CheckItem["state"]) => items.filter((i) => i.state === s).length;
  return {
    passed: count("passed"),
    failed: count("failed"),
    running: count("running"),
    pending: count("pending"),
    skipped: count("skipped"),
    total: items.length,
    items,
  };
}

function isBot(actor: { __typename: string; login: string } | null): boolean {
  if (!actor) return false;
  return actor.__typename === "Bot" || /\[bot\]$|^copilot/i.test(actor.login);
}

type RawThread = RawPullRequest["reviewThreads"]["nodes"][number];

function threadItem(t: RawThread): ThreadItem {
  const first = t.comments.nodes[0];
  const text = (first?.bodyText ?? "").replace(/\s+/g, " ").trim();
  const where = t.path && t.line ? `${t.path}:${t.line}` : (t.path ?? "");
  return {
    author: first?.author?.login ?? "ghost",
    where,
    snippet: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text,
    url: first?.url ?? undefined,
    outdated: t.isOutdated === true,
  };
}

/** Review threads (optionally without bot-started ones): resolved count and the open ones. */
export function summarizeThreads(pr: RawPullRequest, ignoreBotThreads: boolean): PrView["threads"] {
  const nodes = pr.reviewThreads.nodes.filter((t) => !(ignoreBotThreads && isBot(t.comments.nodes[0]?.author ?? null)));
  return {
    resolved: nodes.filter((t) => t.isResolved).length,
    total: nodes.length,
    items: nodes.filter((t) => !t.isResolved).map(threadItem),
  };
}

type RawReview = RawPullRequest["latestOpinionatedReviews"]["nodes"][number];

/** Reviewers still asked to review (users or teams). */
function requestedReviewers(pr: RawPullRequest): ReviewerItem[] {
  return (pr.reviewRequests?.nodes ?? [])
    .map((n) => n.requestedReviewer)
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({ name: r.__typename === "Team" ? `team ${r.name}` : r.login, state: "requested" }));
}

/**
 * Approvals from the latest opinionated review per writer, plus reviewers still asked to review:
 * changes requested first, then still to review, then approved.
 */
export function summarizeReviews(pr: RawPullRequest, required: number): PrView["approvals"] {
  const reviews = pr.latestOpinionatedReviews.nodes;
  const withState = (state: string, as: ReviewerItem["state"]) =>
    reviews
      .filter((r: RawReview) => r.state === state)
      .map((r): ReviewerItem => ({ name: r.author?.login ?? "ghost", state: as, url: r.url ?? undefined }));
  const changes = withState("CHANGES_REQUESTED", "changes");
  const approved = withState("APPROVED", "approved");
  return {
    approved: approved.length,
    required,
    changesRequested: changes.length,
    items: [...changes, ...requestedReviewers(pr), ...approved],
  };
}

/** One status per PR, in order of what needs attention first. */
export function deriveStatus(
  pr: RawPullRequest,
  checks: PrView["checks"],
  threads: PrView["threads"],
  approvals: PrView["approvals"],
): PrStatus {
  if (pr.isDraft) return "draft";
  if (checks.failed > 0) return "failing";
  if (approvals.changesRequested > 0 || pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (checks.running + checks.pending > 0) return "running";
  const ready =
    approvals.approved >= approvals.required && threads.resolved === threads.total && pr.mergeable !== "CONFLICTING";
  return ready ? "ready" : "waiting";
}

function uniq(ids: (number | undefined)[]): number[] {
  return [...new Set(ids.filter((n): n is number => typeof n === "number"))];
}

/** The GitHub Actions workflow runs behind the checks, for "Re-run failed" and "Re-run all". */
export function rerunTargets(items: CheckItem[]): PrView["rerun"] {
  const failed = items.filter((i) => i.state === "failed");
  return {
    failedRunIds: uniq(failed.map((i) => i.runId)),
    allRunIds: uniq(items.map((i) => i.runId)),
    failedExternal: failed.filter((i) => !i.runId).length,
  };
}

/** Everything a PR card shows, from a raw GitHub PR. */
export function toView(pr: RawPullRequest, requiredApprovals: number, opts: ModelOptions): PrView {
  const ticket = ticketsOf(pr, opts.ticketPattern)[0];
  const checks = classifyChecks(pr, opts.ignoredChecks);
  const threads = summarizeThreads(pr, opts.ignoreBotThreads);
  const approvals = summarizeReviews(pr, requiredApprovals);
  const inMergeQueue = pr.isInMergeQueue === true;
  const canUpdateBranch = pr.viewerCanUpdateBranch === true;
  const view: Omit<PrView, "copyGroups"> = {
    id: pr.id,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? "ghost",
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft,
    inMergeQueue,
    ticket,
    ticketUrl: ticketUrl(opts.jiraBaseUrl, ticket),
    status: deriveStatus(pr, checks, threads, approvals),
    checks,
    threads,
    approvals,
    mergeable: pr.mergeable,
    baseRef: pr.baseRefName,
    headOid: pr.headRefOid,
    canUpdateBranch,
    behind: canUpdateBranch && !pr.isDraft && !inMergeQueue,
    rerun: rerunTargets(checks.items),
  };
  return { ...view, copyGroups: copyGroupsOf(view) };
}
