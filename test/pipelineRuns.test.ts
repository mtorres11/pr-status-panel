import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { ActionExecution, commitsByExecution, ignoreAll, mainRevision, personFromArn, stageRuns } from "../src/pipelineRuns";

const SHA_A = "a".repeat(40);
const SHA_B = "B".repeat(40);
const SHA_S = "c".repeat(40);

describe("commitsByExecution", () => {
  test("takes the repo checkout, not a shared-workflow source", () => {
    const m = commitsByExecution([
      { pipelineExecutionId: "e1", sourceRevisions: [{ actionName: "Shared", revisionId: SHA_S }, { actionName: "source-checkout", revisionId: SHA_A }] },
      { pipelineExecutionId: "e2", sourceRevisions: [{ actionName: "Source", revisionId: SHA_B }] },
      { pipelineExecutionId: "e3", sourceRevisions: [{ actionName: "Other", revisionId: SHA_A }] },
      { pipelineExecutionId: "e4", sourceRevisions: [{ actionName: "Source", revisionId: "v1.2" }] },
      { pipelineExecutionId: "e5" },
    ]);
    assert.deepEqual([...m], [["e1", SHA_A], ["e2", SHA_B.toLowerCase()], ["e3", SHA_A]]);
  });
});

describe("mainRevision", () => {
  type Rev = { name?: string; revisionId?: string };
  const byName = (r: Rev) => r.name;

  test("prefers a source or checkout artifact that is not a shared workflow", () => {
    const revs = [
      { name: "SharedWorkflowsSource", revisionId: SHA_S },
      { name: "Build", revisionId: SHA_B },
      { name: "SourceArtifact", revisionId: SHA_A },
    ];
    assert.equal(mainRevision(revs, byName), SHA_A);
  });

  test("falls back to the first own commit, then to a shared one", () => {
    assert.equal(mainRevision([{ name: "Shared", revisionId: SHA_S }, { name: "Build", revisionId: SHA_B }], byName), SHA_B.toLowerCase());
    assert.equal(mainRevision([{ name: "shared-source", revisionId: SHA_S }], byName), SHA_S);
    assert.equal(mainRevision<Rev>([{ revisionId: "v1" }, {}], byName), undefined);
  });
});

describe("personFromArn", () => {
  test("the session name, without the email domain", () => {
    assert.equal(personFromArn("arn:aws:sts::1:assumed-role/Role/jane.doe@example.com"), "jane.doe");
    assert.equal(personFromArn("jane"), undefined);
    assert.equal(personFromArn(undefined), undefined);
  });
});

describe("stageRuns", () => {
  const act = (stageName: string, id: string, status: string, time: string, extra: Partial<ActionExecution> = {}): ActionExecution => ({
    pipelineExecutionId: id,
    stageName,
    status,
    lastUpdateTime: time,
    ...extra,
  });
  const approval = (stage: string, id: string, who: string) =>
    act(stage, id, "Succeeded", "2026-01-01T05:00:00Z", {
      input: { actionTypeId: { category: "Approval" } },
      updatedBy: `arn:aws:sts::1:assumed-role/R/${who}@x.io`,
    });
  const order = ["Source", "Dev", "SignOff", "Prod"];

  test("successful runs per stage, oldest first, with the nearest earlier approver", () => {
    const commits = new Map([["e1", "s1"], ["e2", "s2"]]);
    const runs = stageRuns(
      [
        act("Dev", "e2", "Succeeded", "2026-01-02T00:00:00Z"),
        act("Dev", "e1", "Succeeded", "2026-01-01T00:00:00Z"),
        act("Dev", "e1", "Succeeded", "2026-01-01T01:00:00Z"),
        approval("SignOff", "e1", "ann"),
        act("Prod", "e1", "Succeeded", "2026-01-01T06:00:00Z"),
        act("Prod", "e2", "Failed", "2026-01-02T06:00:00Z"),
        act("Prod", "e3", "Succeeded", "2026-01-03T06:00:00Z"),
      ],
      commits,
      order,
    );
    assert.deepEqual(runs.get("Dev"), [
      { sha: "s1", at: "2026-01-01T01:00:00.000Z", by: undefined },
      { sha: "s2", at: "2026-01-02T00:00:00.000Z", by: undefined },
    ]);
    assert.deepEqual(runs.get("SignOff"), [{ sha: "s1", at: "2026-01-01T05:00:00.000Z", by: "ann" }]);
    assert.deepEqual(runs.get("Prod"), [{ sha: "s1", at: "2026-01-01T06:00:00.000Z", by: "ann" }]);
  });

  test("a run with no time sorts first", () => {
    const runs = stageRuns([act("Dev", "e1", "Succeeded", "")], new Map([["e1", "s1"]]), order);
    assert.deepEqual(runs.get("Dev"), [{ sha: "s1", at: "", by: undefined }]);
  });
});

describe("ignoreAll", () => {
  const states = [
    { stageName: "Source", latestExecution: { pipelineExecutionId: "e1" } },
    { stageName: "Build", latestExecution: { pipelineExecutionId: "e1" } },
    { stageName: "Prod", latestExecution: { pipelineExecutionId: "e2" } },
  ];

  test("true only when every stage on that run is hidden", () => {
    assert.equal(ignoreAll(states, "e1", /^(source|build)$/i), true);
    assert.equal(ignoreAll(states, "e1", /^source$/i), false);
    assert.equal(ignoreAll(states, "e2", undefined), false);
    assert.equal(ignoreAll(states, "none", undefined), true);
  });
});
