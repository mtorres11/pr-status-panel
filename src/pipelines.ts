// Reads AWS CodePipeline history: for each pipeline of a repo, its stages in order and, per stage,
// the successful runs with the commit each one deployed, when it finished and who approved it.

import { AwsConfig, codepipeline } from "./awsCli";
import {
  ActionExecution,
  commitsByExecution,
  ExecutionSummary,
  ignoreAll,
  mainRevision,
  PipelineHistory,
  StageState,
  stageRuns,
} from "./pipelineRuns";
import { TtlCache } from "./ttlCache";

export type { PipelineHistory, StageHistory, StageRun } from "./pipelineRuns";

const HISTORY_TTL_MS = 5 * 60_000;
const LIST_TTL_MS = 30 * 60_000;

/** Runs one `aws codepipeline` command and returns its JSON output. */
export type CodePipelineRun = (cfg: AwsConfig, args: string[]) => Promise<unknown>;

/** The CLI bound to one configuration. */
type Cli = <T>(args: string[]) => Promise<T>;

type ExecutionDetail = { pipelineExecution?: { artifactRevisions?: { name?: string; revisionId?: string }[] } };

/** One pipeline run: its actions and the repo commit it built (skipping shared-workflow sources). */
async function fetchRun(cli: Cli, pipeline: string, id: string): Promise<{ id: string; sha?: string; actions: ActionExecution[] }> {
  const name = ["--pipeline-name", pipeline];
  const [acts, exec] = await Promise.all([
    cli<{ actionExecutionDetails?: ActionExecution[] }>(["list-action-executions", ...name, "--filter", `pipelineExecutionId=${id}`]),
    cli<ExecutionDetail>(["get-pipeline-execution", ...name, "--pipeline-execution-id", id]),
  ]);
  const sha = mainRevision(exec.pipelineExecution?.artifactRevisions ?? [], (r) => r.name);
  return { id, sha, actions: acts.actionExecutionDetails ?? [] };
}

interface RunData {
  states: StageState[];
  actions: ActionExecution[];
  commits: Map<string, string>;
}

/** Stages that deploy rarely (staging, prod) can be older than the recent history: fetch their latest run too. */
async function addLatestRuns(cli: Cli, pipeline: string, data: RunData, ignore: RegExp | undefined): Promise<void> {
  const seen = new Set(data.actions.map((a) => a.pipelineExecutionId));
  const ids = [...new Set(data.states.map((s) => s.latestExecution?.pipelineExecutionId ?? ""))];
  const older = ids.filter((id) => id && !seen.has(id) && !ignoreAll(data.states, id, ignore)).slice(0, 6);
  for (const extra of await Promise.all(older.map((id) => fetchRun(cli, pipeline, id)))) {
    data.actions.push(...extra.actions);
    if (extra.sha) data.commits.set(extra.id, extra.sha);
  }
}

/** A pipeline's current state, recent runs and their actions. */
async function readRuns(cli: Cli, pipeline: string): Promise<RunData> {
  const name = ["--pipeline-name", pipeline];
  const [state, execs, actions] = await Promise.all([
    cli<{ stageStates?: StageState[] }>(["get-pipeline-state", "--name", pipeline]),
    cli<{ pipelineExecutionSummaries?: ExecutionSummary[] }>(["list-pipeline-executions", ...name, "--max-items", "200"]),
    cli<{ actionExecutionDetails?: ActionExecution[] }>(["list-action-executions", ...name, "--max-items", "1000"]),
  ]);
  return {
    states: state.stageStates ?? [],
    actions: actions.actionExecutionDetails ?? [],
    commits: commitsByExecution(execs.pipelineExecutionSummaries ?? []),
  };
}

export class PipelineReader {
  private readonly lists = new TtlCache<string[]>(LIST_TTL_MS);
  private readonly histories = new TtlCache<PipelineHistory>(HISTORY_TTL_MS);

  constructor(private readonly run: CodePipelineRun = codepipeline) {}

  /** Pipelines whose name starts with `prefix`. */
  pipelines(cfg: AwsConfig, prefix: string): Promise<string[]> {
    return this.lists.get(`${cfg.profile}|${cfg.region}|${prefix}`, async () => {
      const res = await this.cli(cfg)<{ pipelines?: { name: string }[] }>(["list-pipelines"]);
      return (res.pipelines ?? []).map((p) => p.name).filter((n) => n.startsWith(prefix)).sort();
    });
  }

  /** Stages (in pipeline order, minus ignored ones) with their successful runs. */
  history(cfg: AwsConfig, pipeline: string, ignore: RegExp | undefined): Promise<PipelineHistory> {
    return this.histories.get(`${cfg.profile}|${cfg.region}|${pipeline}|${ignore?.source ?? ""}`, async () => {
      const cli = this.cli(cfg);
      const data = await readRuns(cli, pipeline);
      await addLatestRuns(cli, pipeline, data, ignore);
      const runs = stageRuns(data.actions, data.commits, data.states.map((s) => s.stageName));
      const stages = data.states
        .filter((s) => !ignore?.test(s.stageName))
        .map((s) => ({ name: s.stageName, runs: runs.get(s.stageName) ?? [], latestStatus: s.latestExecution?.status }));
      return { name: pipeline, stages };
    });
  }

  private cli(cfg: AwsConfig): Cli {
    return <T>(args: string[]) => this.run(cfg, args) as Promise<T>;
  }
}
