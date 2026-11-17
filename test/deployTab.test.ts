import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { readConfig } from "../src/config";
import { DEFAULT_DEPLOY_UI } from "../src/deployFilters";
import { DeployRequest, DeployResult, DeployService } from "../src/deployService";
import { DeployTab } from "../src/deployTab";
import { fakeSettings, fakeUi } from "./fakes";

const API = { restBase: "r", graphqlUrl: "g", token: "t" };

function setup(opts: { signedOut?: boolean; load?: (r: DeployRequest) => Promise<DeployResult>; user?: Record<string, unknown>; profiles?: string[]; pick?: boolean } = {}) {
  const { ui, log } = fakeUi({ pick: opts.pick === false ? () => undefined : undefined });
  const { settings, updates } = fakeSettings({ teamMembers: ["ann"] }, opts.user ?? {});
  const requests: DeployRequest[] = [];
  const service = { load: async (r: DeployRequest) => (requests.push(r), opts.load ? opts.load(r) : { prs: [], aws: { state: "ok" } }) } as unknown as DeployService;
  let changes = 0;
  const tab = new DeployTab({
    github: async () => (opts.signedOut ? undefined : { api: API, key: "github:1", viewer: "me" }),
    ui: () => DEFAULT_DEPLOY_UI,
    config: () => readConfig(settings),
    settings,
    hostUi: ui,
    changed: () => changes++,
    service,
    profiles: async () => opts.profiles ?? [],
    now: () => 42,
  });
  return { tab, log, updates, requests, changes: () => changes };
}

describe("DeployTab", () => {
  test("loads with the settings and keeps the result", async () => {
    const { tab, requests } = setup({ user: { "aws.profile": "dev", "aws.pipelinePrefixes": { "o/r": "app-" } } });
    await tab.refresh(true);
    const r = requests[0];
    assert.equal(r.search.viewer, "me");
    assert.deepEqual(r.search.team, ["ann"]);
    assert.equal(r.aws?.profile, "dev");
    assert.equal(r.pipelinePrefix("o/r"), "app-");
    assert.equal(r.ignoreStages?.source, "^source$");
    assert.equal(tab.updatedAt, 42);
    assert.equal(tab.loading, false);
    assert.deepEqual(tab.payload(), {
      prs: [],
      stageNames: [],
      aws: { state: "ok" },
      error: undefined,
      updatedAt: 42,
      loading: false,
      profile: "dev",
      canSignIn: false,
    });
  });

  test("signed out: an empty list; errors are kept for the panel; reload empties first", async () => {
    const out = setup({ signedOut: true });
    await out.tab.refresh(true);
    assert.equal(out.tab.updatedAt, 0);
    const failing = setup({ load: async () => Promise.reject(new Error("rate limited")) });
    await failing.tab.reload();
    assert.equal(failing.tab.payload().error, "rate limited");
  });

  test("pick a profile: saved at the user level; none, or cancelled", async () => {
    const some = setup({ profiles: ["dev", "prod"] });
    await some.tab.pickProfile();
    assert.deepEqual(some.updates, [["aws.profile", "dev"]]);
    const none = setup();
    await none.tab.pickProfile();
    assert.match(none.log[0], /no profiles yet/);
    const cancel = setup({ profiles: ["dev"], pick: false });
    await cancel.tab.pickProfile();
    assert.deepEqual(cancel.updates, []);
  });

  test("sign in runs the user's command, or opens the setting", () => {
    const set = setup({ user: { "aws.loginCommand": "sso login" } });
    set.tab.signIn();
    assert.deepEqual(set.log, ["terminal AWS sign-in: sso login", "info: PR Status: finish the AWS sign-in in the terminal, then press Refresh in the panel."]);
    assert.equal(set.tab.payload().canSignIn, true);
    const unset = setup();
    unset.tab.signIn();
    assert.deepEqual(unset.log, ["settings: prStatus.aws.loginCommand"]);
  });

  test("defaults: the real service and profile reader", () => {
    const { settings } = fakeSettings();
    const tab = new DeployTab({ github: async () => undefined, ui: () => DEFAULT_DEPLOY_UI, config: () => readConfig(settings), settings, hostUi: fakeUi().ui, changed: () => undefined });
    assert.equal(tab.loading, false);
  });
});
