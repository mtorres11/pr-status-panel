import type { RawPullRequest } from "./github";
import { MAX_REGEX_INPUT } from "./validate";

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

function safeRegex(src: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(src, flags);
  } catch {
    return undefined;
  }
}

function isBot(actor: { __typename: string; login: string } | null): boolean {
  if (!actor) return false;
  return actor.__typename === "Bot" || /\[bot\]$|^copilot/i.test(actor.login);
}

export function toView(
  pr: RawPullRequest,
  requiredApprovals: number,
  opts: ModelOptions,
): PrView {
  // Ticket
  const ticketRe = safeRegex(opts.ticketPattern, "");
  const ticket = ticketRe
    ? (pr.headRefName.slice(0, MAX_REGEX_INPUT).match(ticketRe)?.[0] ??
      pr.title.slice(0, MAX_REGEX_INPUT).match(ticketRe)?.[0])
    : undefined;
  const jira = jiraOrigin(opts.jiraBaseUrl);
  const ticketUrl =
    ticket && jira ? `${jira}/browse/${encodeURIComponent(ticket)}` : undefined;

  // Checks
  const ignored = opts.ignoredChecks
    .map((p) => safeRegex(p, "i"))
    .filter((r): r is RegExp => !!r);
  const contexts =
    pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const items: CheckItem[] = [];
  for (const c of contexts) {
    const name = (c.__typename === "CheckRun" ? c.name : c.context) ?? "check";
    if (ignored.some((r) => r.test(name.slice(0, MAX_REGEX_INPUT)))) continue;
    let state: CheckItem["state"];
    if (c.__typename === "CheckRun") {
      if (c.status !== "COMPLETED")
        state = c.status === "IN_PROGRESS" ? "running" : "pending";
      else if (c.conclusion === "SKIPPED" || c.conclusion === "NEUTRAL")
        state = "skipped";
      else if (c.conclusion && FAILED_CONCLUSIONS.has(c.conclusion))
        state = "failed";
      else state = "passed";
    } else {
      state =
        c.state === "SUCCESS"
          ? "passed"
          : c.state === "FAILURE" || c.state === "ERROR"
            ? "failed"
            : "pending";
    }
    items.push({
      name,
      state,
      url:
        (c.__typename === "CheckRun" ? c.detailsUrl : c.targetUrl) ?? undefined,
      runId:
        c.__typename === "CheckRun"
          ? (c.checkSuite?.workflowRun?.databaseId ?? undefined)
          : undefined,
    });
  }
  const count = (s: CheckItem["state"]) =>
    items.filter((i) => i.state === s).length;
  const checks = {
    passed: count("passed"),
    failed: count("failed"),
    running: count("running"),
    pending: count("pending"),
    skipped: count("skipped"),
    total: items.length,
    items: items.sort(
      (a, b) => order(a.state) - order(b.state) || a.name.localeCompare(b.name),
    ),
  };

  // Review threads
  const threadNodes = pr.reviewThreads.nodes.filter(
    (t) =>
      !(opts.ignoreBotThreads && isBot(t.comments.nodes[0]?.author ?? null)),
  );
  const threads = {
    resolved: threadNodes.filter((t) => t.isResolved).length,
    total: threadNodes.length,
    items: threadNodes
      .filter((t) => !t.isResolved)
      .map((t): ThreadItem => {
        const first = t.comments.nodes[0];
        const text = (first?.bodyText ?? "").replace(/\s+/g, " ").trim();
        return {
          author: first?.author?.login ?? "ghost",
          where: t.path ? (t.line ? `${t.path}:${t.line}` : t.path) : "",
          snippet:
            text.length > SNIPPET_MAX
              ? `${text.slice(0, SNIPPET_MAX - 1)}…`
              : text,
          url: first?.url ?? undefined,
          outdated: t.isOutdated === true,
        };
      }),
  };

  // Approvals (latest opinionated review per writer), plus reviewers still asked to review
  const reviews = pr.latestOpinionatedReviews.nodes;
  const reviewItem = (
    r: (typeof reviews)[number],
    state: ReviewerItem["state"],
  ): ReviewerItem => ({
    name: r.author?.login ?? "ghost",
    state,
    url: r.url ?? undefined,
  });
  const requested = (pr.reviewRequests?.nodes ?? [])
    .map((n) => n.requestedReviewer)
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r): ReviewerItem => ({
      name: r.__typename === "Team" ? `team ${r.name}` : r.login,
      state: "requested",
    }));
  const approvals = {
    approved: reviews.filter((r) => r.state === "APPROVED").length,
    required: requiredApprovals,
    changesRequested: reviews.filter((r) => r.state === "CHANGES_REQUESTED")
      .length,
    // changes requested first, then still to review, then approved
    items: [
      ...reviews
        .filter((r) => r.state === "CHANGES_REQUESTED")
        .map((r) => reviewItem(r, "changes")),
      ...requested,
      ...reviews
        .filter((r) => r.state === "APPROVED")
        .map((r) => reviewItem(r, "approved")),
    ],
  };

  // Overall status
  let status: PrStatus;
  if (pr.isDraft) status = "draft";
  else if (checks.failed > 0) status = "failing";
  else if (
    approvals.changesRequested > 0 ||
    pr.reviewDecision === "CHANGES_REQUESTED"
  )
    status = "changes";
  else if (checks.running + checks.pending > 0) status = "running";
  else if (
    approvals.approved >= approvals.required &&
    threads.resolved === threads.total &&
    pr.mergeable !== "CONFLICTING"
  )
    status = "ready";
  else status = "waiting";

  return {
    id: pr.id,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? "ghost",
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft,
    inMergeQueue: pr.isInMergeQueue === true,
    ticket,
    ticketUrl,
    status,
    checks,
    threads,
    approvals,
    mergeable: pr.mergeable,
    rerun: {
      failedRunIds: uniq(
        items.filter((i) => i.state === "failed").map((i) => i.runId),
      ),
      allRunIds: uniq(items.map((i) => i.runId)),
      failedExternal: items.filter((i) => i.state === "failed" && !i.runId)
        .length,
    },
  };
}

function uniq(ids: (number | undefined)[]): number[] {
  return [...new Set(ids.filter((n): n is number => typeof n === "number"))];
}

function order(s: CheckItem["state"]): number {
  return ["failed", "running", "pending", "passed", "skipped"].indexOf(s);
}

/**
 * Accepts any Jira URL (site, board, issue…) and returns just its origin,
 * e.g. https://x.atlassian.net/jira/software/c/projects/P/boards/1 → https://x.atlassian.net.
 * Returns "" when the value is empty or not an http(s) URL.
 */
export function jiraOrigin(value: string): string {
  const v = value.trim();
  if (!v) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}
