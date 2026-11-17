// What "Copy links" copies (groups) and how the text looks (formats).
import type { PrStatus, PrView } from "./model";

export const COPY_GROUPS = [
  "approval",
  "waiting",
  "ready",
  "failing",
  "changes",
  "running",
  "drafts",
  "behind",
  "queued",
  "all",
] as const;
export type CopyGroup = (typeof COPY_GROUPS)[number];

export const COPY_FORMAT_OPTIONS = [
  ["links", "Links"],
  ["ticket", "Ticket + title + link"],
  ["markdown", "Markdown list"],
] as const;
export type CopyFormat = (typeof COPY_FORMAT_OPTIONS)[number][0];
export const COPY_FORMATS: readonly CopyFormat[] = COPY_FORMAT_OPTIONS.map(([v]) => v);

/** What group membership depends on. */
type GroupFacts = Pick<PrView, "approvals" | "status" | "isDraft" | "behind" | "inMergeQueue">;

/** Which PRs each copy group takes. */
const GROUP_TEST: Record<CopyGroup, (p: GroupFacts) => boolean> = {
  approval: (p) => p.approvals.approved < p.approvals.required && !p.inMergeQueue,
  waiting: (p) => p.status === "waiting",
  ready: (p) => p.status === "ready",
  failing: (p) => p.status === "failing",
  changes: (p) => p.status === "changes",
  running: (p) => p.status === "running",
  drafts: (p) => p.isDraft,
  behind: (p) => p.behind,
  queued: (p) => p.inMergeQueue,
  all: () => true,
};

export function inGroup(p: GroupFacts, group: CopyGroup): boolean {
  return GROUP_TEST[group](p);
}

/** Every group a PR belongs to, in menu order (sent to the panel so it never re-implements the rules). */
export function copyGroupsOf(p: GroupFacts): CopyGroup[] {
  return COPY_GROUPS.filter((g) => GROUP_TEST[g](p));
}

/** Section titles for "All shown", in the same order as the list. */
const STATUS_ORDER: { status: PrStatus; label: string }[] = [
  { status: "failing", label: "Checks failing" },
  { status: "changes", label: "Changes requested" },
  { status: "running", label: "Checks running" },
  { status: "waiting", label: "Waiting on review" },
  { status: "ready", label: "Ready to merge" },
  { status: "draft", label: "Drafts" },
];

const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

/** Chores carry no ticket, even if a key-like string appears in the branch name. */
function ticketOf(p: PrView): { key: string; url?: string } | undefined {
  if (!p.ticket || /^\s*\[?chore\b/i.test(p.title)) return undefined;
  return { key: p.ticket, url: p.ticketUrl };
}

const mdEscape = (t: string): string => t.replace(/([[\]\\])/g, "\\$1");

function formatOne(p: PrView, format: CopyFormat): string {
  const title = oneLine(p.title);
  const t = ticketOf(p);
  if (format === "links") return p.url;
  if (format === "markdown") {
    const ticket = t ? (t.url ? `[${t.key}](${t.url}) ` : `${t.key} `) : "";
    return `- ${ticket}[${mdEscape(title)}](${p.url})`;
  }
  const lines = [t ? `${t.key} · ${title}` : title];
  if (t?.url) lines.push(`Jira: ${t.url}`);
  lines.push(`PR: ${p.url}`);
  return lines.join("\n");
}

function joinItems(prs: PrView[], format: CopyFormat): string {
  return prs
    .map((p) => formatOne(p, format))
    .join(format === "ticket" ? "\n\n" : "\n");
}

/** Clipboard text for these PRs; "All shown" is split into one titled section per status. */
export function copyText(
  prs: PrView[],
  format: CopyFormat,
  grouped: boolean,
): string {
  if (!grouped) return joinItems(prs, format);
  return STATUS_ORDER.map(({ status, label }) => {
    const items = prs.filter((p) => p.status === status);
    if (!items.length) return "";
    const head =
      format === "markdown"
        ? `**${label} (${items.length})**`
        : `${label} (${items.length})`;
    return `${head}\n${joinItems(items, format)}`;
  })
    .filter(Boolean)
    .join("\n\n");
}
