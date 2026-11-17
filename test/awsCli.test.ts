import { after, before, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsError, codepipeline, listProfiles } from "../src/awsCli";

/** A stand-in AWS CLI whose behaviour is picked with FAKE_AWS_MODE. */
const SCRIPT = `#!/usr/bin/env node
const mode = process.env.FAKE_AWS_MODE;
const args = process.argv.slice(2);
if (args[0] === "configure") {
  if (mode === "fail") process.exit(1);
  console.log("dev\\nprod\\nbad name!\\n");
} else if (mode === "ok") console.log(JSON.stringify({ args, pager: process.env.AWS_PAGER }));
else if (mode === "garbage") console.log("not json");
else if (mode === "expired") { console.error("An error occurred (ExpiredToken): the token expired"); process.exit(255); }
else { console.error("first\\nsecond\\nAn error occurred (Throttling): slow down"); process.exit(1); }
`;

let dir = "";
let cli = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "psp-aws-"));
  cli = join(dir, "aws");
  writeFileSync(cli, SCRIPT);
  chmodSync(cli, 0o755);
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_AWS_MODE;
});

const run = (mode: string, profile = "") => {
  process.env.FAKE_AWS_MODE = mode;
  return codepipeline<{ args: string[]; pager: string }>({ cliPath: cli, profile, region: "eu-west-1" }, ["list-pipelines"]);
};

describe("codepipeline", () => {
  test("passes JSON output, region and profile, with the pager off", async () => {
    assert.deepEqual(await run("ok", "dev"), {
      args: ["codepipeline", "list-pipelines", "--output", "json", "--region", "eu-west-1", "--profile", "dev"],
      pager: "",
    });
    assert.deepEqual((await run("ok")).args.slice(-2), ["--region", "eu-west-1"]);
  });

  test("tells a missing CLI, an expired sign-in and other errors apart", async () => {
    process.env.FAKE_AWS_MODE = "ok";
    await assert.rejects(codepipeline({ cliPath: join(dir, "missing"), profile: "", region: "r" }, []), (e: AwsError) => e.kind === "nocli");
    await assert.rejects(run("expired"), (e: AwsError) => e.kind === "signin" && /AWS sign-in needed/.test(e.message));
    await assert.rejects(run("other"), (e: AwsError) => e.kind === "other" && e.message === "AWS: second An error occurred (Throttling): slow down");
    await assert.rejects(run("garbage"), /could not read the CLI output/);
  });
});

describe("listProfiles", () => {
  test("profile names only, nothing on failure", async () => {
    process.env.FAKE_AWS_MODE = "ok";
    assert.deepEqual(await listProfiles(cli), ["dev", "prod"]);
    process.env.FAKE_AWS_MODE = "fail";
    assert.deepEqual(await listProfiles(cli), []);
  });
});
