// What the Deployments tab draws for each PR: where it is now, and per stage how many of its pipelines
// already have it. Computed here so the webview only draws.

import type { StageCell } from "./deployLocation";
import type { DeployPr } from "./deployService";

/** Where a PR is now, from open to in the last stage. */
export type Where = "open" | "reverted" | "missing" | "merged" | "partial" | "done";

/** One stage across a PR's pipelines. */
export interface StageSummary {
  name: string;
  /** Pipelines that have this stage. */
  total: number;
  /** Pipelines where it is already deployed. */
  deployed: number;
  /** The earliest arrival. */
  first?: StageCell;
}

/** A PR as the Deployments tab draws it. */
export interface DeployPrView extends DeployPr {
  where: Where;
  /** One entry per stage name of the whole list (see DeploySummary.stageNames), in that order. */
  stages: StageSummary[];
  /** Passes the "Where" filter. */
  shown: boolean;
}

interface DeploySummary {
  prs: DeployPrView[];
  /** Every stage name in the list, in pipeline order. */
  stageNames: string[];
}

/** Stage names in pipeline order, across PRs and their pipelines, without repeats. */
function stageNamesOf(prs: DeployPr[]): string[] {
  const names = prs.flatMap((pr) => pr.tracks.flatMap((t) => t.stages.map((s) => s.name)));
  return [...new Set(names)];
}

function stageSummary(pr: DeployPr, name: string): StageSummary {
  const cells = pr.tracks.map((t) => t.stages.find((s) => s.name === name)).filter((c): c is StageCell => !!c);
  const done = cells
    .filter((c) => c.state === "deployed")
    .sort((a, b) => (a.firstAt ?? "").localeCompare(b.firstAt ?? ""));
  return { name, total: cells.length, deployed: done.length, first: done[0] };
}

export function whereOf(pr: DeployPr): Where {
  if (pr.state === "OPEN") return "open";
  if (pr.revert) return "reverted";
  if (pr.inBranch === false) return "missing";
  const stages = stageNamesOf([pr]).map((n) => stageSummary(pr, n));
  const last = stages[stages.length - 1];
  if (!last) return "merged";
  if (last.deployed && last.deployed === last.total) return "done";
  return stages.some((s) => s.deployed) ? "partial" : "merged";
}

const FILTERS: Record<string, (pr: DeployPr) => boolean> = {
  "": () => true,
  open: (pr) => pr.state === "OPEN",
  inBranch: (pr) => pr.state === "MERGED" && pr.inBranch !== false && !pr.revert,
  notInBranch: (pr) => pr.state === "MERGED" && (pr.inBranch === false || !!pr.revert),
  reverted: (pr) => !!pr.revert,
};

/** The "Where" filter: a fixed choice, or "in:<stage>" / "notin:<stage>". */
export function matchesWhere(pr: DeployPr, filter: string): boolean {
  if (Object.hasOwn(FILTERS, filter)) return FILTERS[filter](pr);
  const colon = filter.indexOf(":");
  if (pr.state !== "MERGED" || colon < 0) return false;
  const s = stageSummary(pr, filter.slice(colon + 1));
  return filter.slice(0, colon) === "in" ? s.deployed > 0 : s.total > 0 && s.deployed < s.total;
}

export function summarize(prs: DeployPr[], filter: string): DeploySummary {
  const stageNames = stageNamesOf(prs);
  return {
    stageNames,
    prs: prs.map((pr) => ({
      ...pr,
      where: whereOf(pr),
      stages: stageNames.map((n) => stageSummary(pr, n)),
      shown: matchesWhere(pr, filter),
    })),
  };
}
