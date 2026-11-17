// Where a PR's change is now: in the chosen branch or not, reverted or not, and for each pipeline stage
// whether a successful run already contains it, plus when it first got there and who approved it.

import type { ApiTarget } from "./github";
import type { BranchCommits, BranchIndex } from "./deployGithub";
import type { PipelineHistory, StageHistory, StageRun } from "./pipelines";

export interface StageCell {
  name: string;
  state: "deployed" | "not-yet" | "unknown";
  /** First successful run that contained the change. */
  firstAt?: string;
  by?: string;
  /** The change was already there in the oldest run we can see, so it may have arrived earlier. */
  orEarlier?: boolean;
  /** Status of the stage's latest run when it is not Succeeded (InProgress, Failed…). */
  latestStatus?: string;
}

export interface PipelineTrack {
  pipeline: string;
  stages: StageCell[];
}

export interface RevertInfo {
  sha: string;
  date: string;
  message: string;
}

type Contains = (sha: string, ref: string) => Promise<boolean | undefined>;

export function containsFn(
  branches: BranchCommits,
  api: ApiTarget,
  repo: string,
  idx?: BranchIndex,
): Contains {
  return (sha, ref) => branches.isIn(api, repo, sha, ref, idx);
}

/** Earliest run containing `sha`. Runs are oldest first and deploy a moving branch, so containment only grows. */
async function firstContaining(
  runs: StageRun[],
  sha: string,
  contains: Contains,
): Promise<number> {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await contains(sha, runs[mid].sha)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function stageCell(
  stage: StageHistory,
  sha: string,
  contains: Contains,
): Promise<StageCell> {
  const base = {
    name: stage.name,
    latestStatus:
      stage.latestStatus === "Succeeded" ? undefined : stage.latestStatus,
  };
  const latest = stage.runs[stage.runs.length - 1];
  if (!latest) return { ...base, state: "unknown" };
  const there = await contains(sha, latest.sha);
  if (there === undefined) return { ...base, state: "unknown" };
  if (!there) return { ...base, state: "not-yet" };
  const i = await firstContaining(stage.runs, sha, contains);
  const run = stage.runs[i];
  return {
    ...base,
    state: "deployed",
    firstAt: run.at,
    by: run.by,
    orEarlier: i === 0,
  };
}

/** Stage track of one pipeline for a merged change. */
export async function trackFor(
  history: PipelineHistory,
  sha: string,
  contains: Contains,
): Promise<PipelineTrack> {
  const stages: StageCell[] = [];
  for (const s of history.stages)
    stages.push(await stageCell(s, sha, contains));
  return { pipeline: history.name, stages };
}

/** A later commit on the branch whose message reverts PR #number (GitHub's `Revert "… (#N)"`). */
export function findRevert(
  idx: BranchIndex | undefined,
  mergeSha: string,
  number: number,
): RevertInfo | undefined {
  const pos = idx?.position.get(mergeSha);
  if (!idx || pos === undefined) return undefined;
  const tag = `(#${number})`;
  const hit = idx.commits
    .slice(0, pos)
    .reverse()
    .find((c) => /^Revert "/.test(c.message) && c.message.includes(tag));
  return hit
    ? { sha: hit.sha, date: hit.date, message: hit.message }
    : undefined;
}
