// Reads AWS CodePipeline history: for each pipeline of a repo, its stages in order and, per stage,
// the successful runs with the commit each one deployed, when it finished and who approved it.

import { AwsConfig, codepipeline } from "./awsCli";
import {
  ActionExecution,
  commitsByExecution,
  ExecutionSummary,
  ignoreAll,
  PipelineHistory,
  SHA_RE,
  StageState,
  stageRuns,
} from "./pipelineRuns";

export type { PipelineHistory, StageHistory, StageRun } from "./pipelineRuns";

const HISTORY_TTL_MS = 5 * 60_000;
const LIST_TTL_MS = 30 * 60_000;

/** One pipeline run: its actions and the repo commit it built (skipping shared-workflow sources). */
async function fetchRun(cfg: AwsConfig, pipeline: string, id: string): Promise<{ id: string; sha?: string; actions: ActionExecution[] }> {
  const name = ["--pipeline-name", pipeline];
  const [acts, exec] = await Promise.all([
    codepipeline<{ actionExecutionDetails?: ActionExecution[] }>(cfg, ["list-action-executions", ...name, "--filter", `pipelineExecutionId=${id}`]),
    codepipeline<{ pipelineExecution?: { artifactRevisions?: { name?: string; revisionId?: string }[] } }>(cfg, [
      "get-pipeline-execution", ...name, "--pipeline-execution-id", id,
    ]),
  ]);
  const revs = (exec.pipelineExecution?.artifactRevisions ?? []).filter((r) => SHA_RE.test(r.revisionId ?? ""));
  const main = revs.find((r) => /source|checkout/i.test(r.name ?? "") && !/shared/i.test(r.name ?? "")) ?? revs[0];
  return { id, sha: main?.revisionId?.toLowerCase(), actions: acts.actionExecutionDetails ?? [] };
}

interface RunData {
  states: StageState[];
  actions: ActionExecution[];
  commits: Map<string, string>;
}

/** Stages that deploy rarely (staging, prod) can be older than the recent history: fetch their latest run too. */
async function addLatestRuns(cfg: AwsConfig, pipeline: string, data: RunData, ignore: RegExp | undefined): Promise<void> {
  const seen = new Set(data.actions.map((a) => a.pipelineExecutionId));
  const ids = [...new Set(data.states.map((s) => s.latestExecution?.pipelineExecutionId ?? ""))];
  const older = ids.filter((id) => id && !seen.has(id) && !ignoreAll(data.states, id, ignore)).slice(0, 6);
  for (const extra of await Promise.all(older.map((id) => fetchRun(cfg, pipeline, id)))) {
    data.actions.push(...extra.actions);
    if (extra.sha) data.commits.set(extra.id, extra.sha);
  }
}

export class PipelineReader {
  private cache = new Map<string, { at: number; value: unknown }>();

  /** Memoizes `load` under `key` for `ttl` milliseconds. */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Pipelines whose name starts with `prefix`. */
  pipelines(cfg: AwsConfig, prefix: string): Promise<string[]> {
    return this.cached(`list|${cfg.profile}|${cfg.region}|${prefix}`, LIST_TTL_MS, async () => {
      const res = await codepipeline<{ pipelines?: { name: string }[] }>(cfg, ["list-pipelines"]);
      return (res.pipelines ?? []).map((p) => p.name).filter((n) => n.startsWith(prefix)).sort();
    });
  }

  /** Stages (in pipeline order, minus ignored ones) with their successful runs. */
  history(cfg: AwsConfig, pipeline: string, ignore: RegExp | undefined): Promise<PipelineHistory> {
    return this.cached(`history|${cfg.profile}|${cfg.region}|${pipeline}|${ignore?.source ?? ""}`, HISTORY_TTL_MS, async () => {
      const name = ["--pipeline-name", pipeline];
      const [state, execs, actions] = await Promise.all([
        codepipeline<{ stageStates?: StageState[] }>(cfg, ["get-pipeline-state", "--name", pipeline]),
        codepipeline<{ pipelineExecutionSummaries?: ExecutionSummary[] }>(cfg, ["list-pipeline-executions", ...name, "--max-items", "200"]),
        codepipeline<{ actionExecutionDetails?: ActionExecution[] }>(cfg, ["list-action-executions", ...name, "--max-items", "1000"]),
      ]);
      const data: RunData = {
        states: state.stageStates ?? [],
        actions: actions.actionExecutionDetails ?? [],
        commits: commitsByExecution(execs.pipelineExecutionSummaries ?? []),
      };
      await addLatestRuns(cfg, pipeline, data, ignore);
      const runs = stageRuns(data.actions, data.commits, data.states.map((s) => s.stageName));
      const stages = data.states
        .filter((s) => !ignore?.test(s.stageName))
        .map((s) => ({ name: s.stageName, runs: runs.get(s.stageName) ?? [], latestStatus: s.latestExecution?.status }));
      return { name: pipeline, stages };
    });
  }
}
