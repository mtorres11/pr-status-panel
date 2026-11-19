// In-memory stand-ins for the editor ports.

import type { PrClient } from "../src/core/githubPrs";
import type { Auth, AuthAccount, HostUi, KeyValueStore, SessionOptions, Settings } from "../src/core/ports";

/** Settings backed by two maps: effective values and user-level values ("section.key" outside prStatus). */
export function fakeSettings(effective: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  const updates: [string, unknown][] = [];
  const settings: Settings = {
    get: <T>(key: string, fallback: T) => (key in effective ? (effective[key] as T) : fallback),
    user: <T>(key: string, fallback: T, section = "prStatus") => {
      const k = section === "prStatus" ? key : `${section}.${key}`;
      return k in user && user[k] !== null ? (user[k] as T) : fallback;
    },
    update: async (key, value) => {
      updates.push([key, value]);
      effective[key] = value;
    },
  };
  return { settings, updates };
}

/** A HostUi that records what it was asked and answers from `answers`. */
export function fakeUi(answers: { confirm?: boolean; prompt?: string; pick?: (items: { label: string }[]) => unknown } = {}) {
  const log: string[] = [];
  const ui: HostUi = {
    confirm: async (message) => (log.push(`confirm: ${message}`), answers.confirm ?? true),
    info: (m) => void log.push(`info: ${m}`),
    warn: (m) => void log.push(`warn: ${m}`),
    error: (m) => void log.push(`error: ${m}`),
    progress: (title, task) => (log.push(`progress: ${title}`), task()),
    copy: async (text, flash) => void log.push(`copy: ${text}${flash ? ` | ${flash}` : ""}`),
    openUrl: (url) => void log.push(`open: ${url}`),
    prompt: async (o) => {
      log.push(`prompt: ${o.prompt}`);
      if (answers.prompt !== undefined) log.push(`validate: ${o.validate(answers.prompt) ?? "ok"}`);
      return answers.prompt;
    },
    pick: async <T extends { label: string }>(items: T[]) => (answers.pick ? (answers.pick(items) as T | undefined) : items[0]),
    runInTerminal: (name, command) => void log.push(`terminal ${name}: ${command}`),
    openSettings: (query) => void log.push(`settings: ${query}`),
  };
  return { ui, log };
}

/** Accounts per provider and the sessions they give. */
export function fakeAuth(accounts: Record<string, AuthAccount[]>, opts: { signedOut?: boolean; fail?: string } = {}) {
  const calls: { providerId: string; options: SessionOptions }[] = [];
  const auth: Auth = {
    accounts: async (providerId) => {
      if (!(providerId in accounts)) throw new Error("no provider");
      return accounts[providerId];
    },
    session: async (providerId, _scopes, options) => {
      calls.push({ providerId, options });
      if (opts.fail) throw new Error(opts.fail);
      if (opts.signedOut && options.silent) return undefined;
      const account = options.account ?? accounts[providerId]?.[0] ?? { id: "new", label: "New" };
      return { accessToken: `token-${account.id}`, account };
    },
  };
  return { auth, calls };
}

/** A key-value store in memory. */
export function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: (key) => data[key],
    set: async (key, value) => void (data[key] = value),
  };
}

/** A PrClient answering from fixed data and recording the writes. */
export function fakeClient(over: Partial<PrClient> = {}) {
  const writes: string[] = [];
  const client: PrClient = {
    search: async () => [],
    viewerLogin: async () => "me",
    repos: async () => [],
    requiredApprovals: async () => undefined,
    teamMembers: async () => undefined,
    rerun: async (_api, repo, runId, failedOnly) => void writes.push(`rerun ${repo} ${runId} ${failedOnly}`),
    updateBranch: async (_api, prId, head, method) => void writes.push(`update ${prId} ${head} ${method}`),
    ...over,
  };
  return { client, writes };
}

/** A recorded HTTP call. */
export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Replaces fetch with `answer` (status and JSON body, or text) until the returned restore is called. */
export function stubFetch(answer: (call: FetchCall) => { status?: number; json?: unknown; text?: string }) {
  const calls: FetchCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const a = answer(call);
    const text = a.text ?? JSON.stringify(a.json ?? null);
    return new Response(text, { status: a.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
