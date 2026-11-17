import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { awsConfig, awsLoginCommand, fetchSnapshot, ignoredStages, pipelinePrefix, readConfig } from "../src/core/config";
import { fakeSettings } from "./fakes";

describe("readConfig", () => {
  test("defaults", () => {
    const c = readConfig(fakeSettings().settings);
    assert.equal(c.refreshIntervalSeconds, 60);
    assert.equal(c.ticketPattern, "[A-Z][A-Z0-9]+-\\d+");
    assert.equal(c.enterpriseUri, "");
    assert.deepEqual(c.organizations, []);
  });

  test("checks lists and the interval floor", () => {
    const { settings } = fakeSettings({
      refreshIntervalSeconds: 5,
      organizations: ["acme", "bad org"],
      favoriteRepos: ["o/r", "x"],
      teamMembers: "ann",
    });
    const c = readConfig(settings);
    assert.equal(c.refreshIntervalSeconds, 15);
    assert.deepEqual(c.organizations, ["acme"]);
    assert.deepEqual(c.favoriteRepos, ["o/r"]);
    assert.deepEqual(c.teamMembers, []);
  });

  test("the Enterprise server comes from the user level only and must be https", () => {
    assert.equal(readConfig(fakeSettings({}, { "github-enterprise.uri": "https://ghe.io" }).settings).enterpriseUri, "https://ghe.io");
    assert.equal(readConfig(fakeSettings({}, { "github-enterprise.uri": "http://ghe.io" }).settings).enterpriseUri, "");
  });

  test("the snapshot ignores favorites", () => {
    const a = readConfig(fakeSettings({ favoriteRepos: ["o/a"] }).settings);
    const b = readConfig(fakeSettings({ favoriteRepos: ["o/b"] }).settings);
    assert.equal(fetchSnapshot(a), fetchSnapshot(b));
    assert.notEqual(fetchSnapshot(a), fetchSnapshot({ ...a, compact: true }));
  });
});

describe("AWS settings", () => {
  test("defaults, user level only", () => {
    const workspaceOnly = fakeSettings({ "aws.cliPath": "/tmp/other" }).settings;
    assert.deepEqual(awsConfig(workspaceOnly), { cliPath: "aws", profile: "", region: "us-east-1" });
  });

  test("off, or unsafe values, give no config", () => {
    assert.equal(awsConfig(fakeSettings({}, { "aws.enabled": false }).settings), undefined);
    assert.equal(awsConfig(fakeSettings({}, { "aws.cliPath": "aws && echo x" }).settings), undefined);
    assert.equal(awsConfig(fakeSettings({}, { "aws.profile": "a b" }).settings), undefined);
    assert.equal(awsConfig(fakeSettings({}, { "aws.region": "US" }).settings), undefined);
  });

  test("custom values are trimmed; blanks fall back", () => {
    const { settings } = fakeSettings({}, { "aws.cliPath": " ", "aws.profile": " dev ", "aws.region": " " });
    assert.deepEqual(awsConfig(settings), { cliPath: "aws", profile: "dev", region: "us-east-1" });
  });

  test("pipeline prefix per repo, else the repo name", () => {
    const { settings } = fakeSettings({}, { "aws.pipelinePrefixes": { "o/a": " app- ", "o/b": 3 } });
    assert.equal(pipelinePrefix(settings, "o/a"), "app-");
    assert.equal(pipelinePrefix(settings, "o/b"), "b-");
  });

  test("ignored stages and the login command", () => {
    assert.equal(ignoredStages(fakeSettings().settings)?.test("SOURCE"), true);
    assert.equal(ignoredStages(fakeSettings({}, { "aws.ignoreStages": "" }).settings), undefined);
    assert.equal(ignoredStages(fakeSettings({}, { "aws.ignoreStages": "(" }).settings), undefined);
    assert.equal(awsLoginCommand(fakeSettings({}, { "aws.loginCommand": " sso login " }).settings), "sso login");
  });
});
