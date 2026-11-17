// The messages between the extension and its webview, and the data the webview draws.
// Webview messages are untrusted: parseMessage checks the shape of every field, and the handlers check the
// values again against the extension's own data (known PR ids, https links, valid repos).

import { COPY_FORMATS, COPY_GROUPS, CopyFormat, CopyGroup } from "./copy";
import type { AwsStatus, DeployPr } from "./deployService";
import type { PrView } from "./model";
import type { UiState } from "./uiState";
import { asRecord, isHttpsUrl, isRepo, oneOf } from "./validate";

/** Webview → extension. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "setState"; patch: Record<string, unknown> }
  | { type: "copyUrl"; prId: string; which: "pr" | "ticket" }
  | { type: "copyLinks"; ids: string[]; group: CopyGroup; format: CopyFormat }
  | { type: "rerun"; prId: string; failedOnly: boolean }
  | { type: "updateBranch"; prId: string; method: "MERGE" | "REBASE" }
  | { type: "configureJira"; ticket: string }
  | { type: "open"; url: string }
  | { type: "toggleFavorite"; repo: string }
  | { type: "addAccount" }
  | { type: "signIn" }
  | { type: "openSettings" }
  | { type: "awsProfile" }
  | { type: "awsSignIn" };

export type MessageType = WebviewMessage["type"];
export type MessageOf<K extends MessageType> = Extract<WebviewMessage, { type: K }>;

/** One handler per webview message type. */
export type MessageHandlers = { [K in MessageType]: (m: MessageOf<K>) => unknown };

/** A GitHub account the user can switch to. */
export interface AccountChoice {
  key: string;
  label: string;
}

/** Credit line in the footer. */
export interface About {
  author: string;
  repoUrl: string;
  version: string;
}

/** What the Deployments tab draws. */
export interface DeployPayload {
  prs: DeployPr[];
  loading: boolean;
  error?: string;
  hint?: string;
  aws: AwsStatus;
  updatedAt?: number;
  /** AWS profile in use ("" = the CLI's default). */
  profile: string;
  /** A sign-in command is set up. */
  canSignIn: boolean;
}

/** Everything the webview draws, sent whole on every change. */
export interface Payload {
  ui: UiState;
  accounts: AccountChoice[];
  viewerLogin?: string;
  team: string[];
  favorites: string[];
  repos: string[];
  prs: PrView[];
  loading: boolean;
  error?: string;
  needsSignIn: boolean;
  updatedAt?: number;
  compact: boolean;
  groupByRepo: boolean;
  about: About;
  deploy: DeployPayload;
}

/** Extension → webview. */
export type HostMessage = { type: "update"; payload: Payload };

type Raw = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const pickOr = <T>(list: readonly T[], v: unknown, fallback: T): T => (oneOf(list)(v) ? v : fallback);
const bare =
  <K extends MessageType>(type: K) =>
  () =>
    ({ type }) as MessageOf<K>;

/** Reads each message type from raw webview data; undefined drops a message that cannot be valid. */
const PARSERS: { [K in MessageType]: (m: Raw) => MessageOf<K> | undefined } = {
  ready: bare("ready"),
  refresh: bare("refresh"),
  setState: (m) => ({ type: "setState", patch: asRecord(m.patch) }),
  copyUrl: (m) => ({ type: "copyUrl", prId: text(m.prId), which: m.which === "ticket" ? "ticket" : "pr" }),
  copyLinks: (m) => ({
    type: "copyLinks",
    ids: Array.isArray(m.ids) ? m.ids.filter((v): v is string => typeof v === "string") : [],
    group: pickOr(COPY_GROUPS, m.group, "approval"),
    format: pickOr(COPY_FORMATS, m.format, "links"),
  }),
  rerun: (m) => ({ type: "rerun", prId: text(m.prId), failedOnly: m.mode === "failed" }),
  updateBranch: (m) => ({ type: "updateBranch", prId: text(m.prId), method: m.method === "rebase" ? "REBASE" : "MERGE" }),
  configureJira: (m) => ({ type: "configureJira", ticket: text(m.ticket) }),
  // Only https links (PRs, check runs, Jira) are ever handed to the browser.
  open: (m) => (isHttpsUrl(m.url) ? { type: "open", url: m.url } : undefined),
  toggleFavorite: (m) => (isRepo(m.repo) ? { type: "toggleFavorite", repo: m.repo } : undefined),
  addAccount: bare("addAccount"),
  signIn: bare("signIn"),
  openSettings: bare("openSettings"),
  awsProfile: bare("awsProfile"),
  awsSignIn: bare("awsSignIn"),
};

/** A typed webview message, or undefined for an unknown type or invalid fields. */
export function parseMessage(raw: unknown): WebviewMessage | undefined {
  const m = asRecord(raw);
  const parse = Object.hasOwn(PARSERS, text(m.type)) ? PARSERS[m.type as MessageType] : undefined;
  return parse?.(m);
}

/** Parses a raw webview message and runs its handler; invalid messages are dropped. */
export async function routeMessage(handlers: MessageHandlers, raw: unknown): Promise<void> {
  const m = parseMessage(raw);
  if (m) await (handlers[m.type] as (msg: WebviewMessage) => unknown)(m);
}
