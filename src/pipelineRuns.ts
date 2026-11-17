// Pure CodePipeline history logic: which commit each run built, which stage runs succeeded, who approved.
// No AWS calls here.

export const SHA_RE = /^[0-9a-f]{40}$/i;

/** One successful run of a stage. */
export interface StageRun {
  sha: string;
  at: string;
  /** Who approved it, for manual approval stages. */
  by?: string;
}

export interface StageHistory {
  name: string;
  /** Successful runs, oldest first. */
  runs: StageRun[];
  /** Status of the stage's latest run, e.g. InProgress or Failed. */
  latestStatus?: string;
}

export interface PipelineHistory {
  name: string;
  stages: StageHistory[];
}

export interface ActionExecution {
  pipelineExecutionId: string;
  stageName: string;
  status: string;
  lastUpdateTime?: string;
  updatedBy?: string;
  input?: { actionTypeId?: { category?: string } };
}

export interface ExecutionSummary {
  pipelineExecutionId: string;
  sourceRevisions?: { actionName?: string; revisionId?: string }[];
}

export interface StageState {
  stageName: string;
  latestExecution?: { status?: string; pipelineExecutionId?: string };
}

/** "arn:aws:sts::1:assumed-role/Role/jane.doe@example.com" → "jane.doe". */
export function personFromArn(arn: string | undefined): string | undefined {
  if (!arn || !/^arn:aws/.test(arn)) return undefined;
  const last = arn.split("/").pop() ?? "";
  return last.split("@")[0].slice(0, 60) || undefined;
}

/** Commit each pipeline run built from: the repo checkout's revision (not shared-workflow sources). */
export function commitsByExecution(execs: ExecutionSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of execs) {
    const revs = (e.sourceRevisions ?? []).filter((r) => SHA_RE.test(r.revisionId ?? ""));
    const main = revs.find((r) => /source-checkout|^source$/i.test(r.actionName ?? "")) ?? revs[0];
    if (main?.revisionId) out.set(e.pipelineExecutionId, main.revisionId.toLowerCase());
  }
  return out;
}

const iso = (t: string | undefined) => (t ? new Date(t).toISOString() : "");
const stageKey = (stage: string, execId: string) => `${stage}\u0000${execId}`;

function groupByStageRun(actions: ActionExecution[]): Map<string, ActionExecution[]> {
  const groups = new Map<string, ActionExecution[]>();
  for (const a of actions) {
    const key = stageKey(a.stageName, a.pipelineExecutionId);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return groups;
}

/** Who approved a manual-approval stage in a given pipeline run: key → person. */
function approvers(groups: Map<string, ActionExecution[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, group] of groups) {
    const a = group.find((x) => x.input?.actionTypeId?.category === "Approval" && x.status === "Succeeded");
    const who = personFromArn(a?.updatedBy);
    if (who) out.set(key, who);
  }
  return out;
}

/**
 * Successful runs per stage, oldest first. A stage run is successful when every action in it succeeded.
 * `by` is whoever approved the nearest sign-off before that stage in the same pipeline run
 * (e.g. Staging-SignOff → Production-Deployment), or the stage itself when it is an approval.
 */
export function stageRuns(actions: ActionExecution[], commits: Map<string, string>, order: string[]): Map<string, StageRun[]> {
  const groups = groupByStageRun(actions);
  const approved = approvers(groups);
  const approverFor = (stage: string, execId: string) => {
    for (let i = order.indexOf(stage); i >= 0; i--) {
      const who = approved.get(stageKey(order[i], execId));
      if (who) return who;
    }
    return undefined;
  };
  const out = new Map<string, StageRun[]>();
  for (const [key, group] of groups) {
    const [stage, execId] = key.split("\u0000");
    const sha = commits.get(execId);
    if (!sha || !group.every((a) => a.status === "Succeeded")) continue;
    const at = group.map((a) => iso(a.lastUpdateTime)).sort().pop() ?? "";
    out.set(stage, [...(out.get(stage) ?? []), { sha, at, by: approverFor(stage, execId) }]);
  }
  for (const runs of out.values()) runs.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/** True when every stage whose latest run is `id` is hidden (no need to fetch that run). */
export function ignoreAll(states: StageState[], id: string, ignore: RegExp | undefined): boolean {
  return states.filter((s) => s.latestExecution?.pipelineExecutionId === id).every((s) => !!ignore?.test(s.stageName));
}

