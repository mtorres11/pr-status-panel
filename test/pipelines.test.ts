import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { PipelineReader } from "../src/pipelines";

const CFG = { cliPath: "aws", profile: "dev", region: "us-east-1" };
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

/** Answers each CodePipeline command from a table, recording the calls. */
function fakeCli(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const run = async (_cfg: unknown, args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    const hit = Object.keys(answers).find((k) => key.startsWith(k));
    return hit ? answers[hit] : {};
  };
  return { run, calls };
}

const ok = (stageName: string, id: string, time: string, extra: object = {}) => ({
  pipelineExecutionId: id,
  stageName,
  status: "Succeeded",
  lastUpdateTime: time,
  ...extra,
});

describe("PipelineReader", () => {
  test("lists a repo's pipelines by prefix, cached", async () => {
    const { run, calls } = fakeCli({ "list-pipelines": { pipelines: [{ name: "app-web" }, { name: "other" }, { name: "app-api" }] } });
    const reader = new PipelineReader(run);
    assert.deepEqual(await reader.pipelines(CFG, "app-"), ["app-api", "app-web"]);
    await reader.pipelines(CFG, "app-");
    assert.equal(calls.length, 1);
    const empty = new PipelineReader(fakeCli({}).run);
    assert.deepEqual(await empty.pipelines(CFG, "x"), []);
  });

  test("history: stages in order, ignored ones hidden, older latest runs fetched too", async () => {
    const { run, calls } = fakeCli({
      "get-pipeline-state": {
        stageStates: [
          { stageName: "Source", latestExecution: { pipelineExecutionId: "e2", status: "Succeeded" } },
          { stageName: "Dev", latestExecution: { pipelineExecutionId: "e2", status: "Succeeded" } },
          { stageName: "Prod", latestExecution: { pipelineExecutionId: "e1", status: "Failed" } },
        ],
      },
      "list-pipeline-executions": { pipelineExecutionSummaries: [{ pipelineExecutionId: "e2", sourceRevisions: [{ actionName: "Source", revisionId: SHA2 }] }] },
      "list-action-executions --pipeline-name p --max-items": { actionExecutionDetails: [ok("Dev", "e2", "2026-01-02T00:00:00Z")] },
      "list-action-executions --pipeline-name p --filter": { actionExecutionDetails: [ok("Prod", "e1", "2026-01-01T00:00:00Z")] },
      "get-pipeline-execution": { pipelineExecution: { artifactRevisions: [{ name: "SourceArtifact", revisionId: SHA1 }] } },
    });
    const h = await new PipelineReader(run).history(CFG, "p", /^source$/i);
    assert.deepEqual(h, {
      name: "p",
      stages: [
        { name: "Dev", runs: [{ sha: SHA2, at: "2026-01-02T00:00:00.000Z", by: undefined }], latestStatus: "Succeeded" },
        { name: "Prod", runs: [{ sha: SHA1, at: "2026-01-01T00:00:00.000Z", by: undefined }], latestStatus: "Failed" },
      ],
    });
    assert.ok(calls.includes("get-pipeline-execution --pipeline-name p --pipeline-execution-id e1"));
  });

  test("history of an empty pipeline", async () => {
    const h = await new PipelineReader(fakeCli({ "get-pipeline-execution": {} }).run).history(CFG, "p", undefined);
    assert.deepEqual(h, { name: "p", stages: [] });
  });

  test("a latest run without a commit or actions adds nothing", async () => {
    const { run } = fakeCli({
      "get-pipeline-state": { stageStates: [{ stageName: "Prod", latestExecution: { pipelineExecutionId: "e9" } }] },
    });
    const h = await new PipelineReader(run).history(CFG, "p", undefined);
    assert.deepEqual(h.stages, [{ name: "Prod", runs: [], latestStatus: undefined }]);
  });
});
