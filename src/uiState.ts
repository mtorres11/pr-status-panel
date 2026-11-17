// The panel's UI state (filters, sort, copy options, Deployments filters): its shape, defaults and validation.
// Every value comes from the webview or from storage, so each one is checked before use.

import { COPY_FORMATS, COPY_GROUPS, CopyFormat, CopyGroup } from "./copy";
import { DEFAULT_DEPLOY_UI, deployPatch, DeployUi } from "./deployFilters";
import type { KeyValueStore } from "./ports";
import { asRecord, isLogin, isRepo, oneOf, pickValid } from "./validate";

export const SHOW_MODES = ["authored", "review", "assigned", "all"] as const;
export const SORT_MODES = ["attention", "updated", "ticket"] as const;

export type ShowMode = (typeof SHOW_MODES)[number];
export type SortMode = (typeof SORT_MODES)[number];

/** The PR tab's filters and copy options. */
export interface PrUi {
  /** "@me" | "@team" | a login; "@other" only in a patch, while asking for the login. */
  author: string;
  /** "*" or owner/name */
  repo: string;
  show: ShowMode;
  drafts: boolean;
  sort: SortMode;
  /** Which PRs "Copy links" takes. */
  copyGroup: CopyGroup;
  /** How the copied text looks. */
  copyFormat: CopyFormat;
}

export interface UiState extends PrUi, DeployUi {
  accountKey?: string;
}

export const DEFAULT_UI: UiState = {
  author: "@me",
  repo: "*",
  show: "authored",
  drafts: true,
  sort: "attention",
  copyGroup: "approval",
  copyFormat: "links",
  ...DEFAULT_DEPLOY_UI,
};

const VALID: Record<keyof PrUi, (v: unknown) => boolean> = {
  author: (v) => v === "@me" || v === "@team" || v === "@other" || isLogin(v),
  repo: (v) => v === "*" || isRepo(v),
  show: oneOf(SHOW_MODES),
  drafts: (v) => typeof v === "boolean",
  sort: oneOf(SORT_MODES),
  copyGroup: oneOf(COPY_GROUPS),
  copyFormat: oneOf(COPY_FORMATS),
};

/** Keeps only known UI keys with valid values; an account key must be one of `accountKeys`. */
export function validPatch(raw: unknown, accountKeys: string[]): Partial<UiState> {
  const p = asRecord(raw);
  const out: Partial<UiState> = pickValid<PrUi>(p, VALID);
  if (typeof p.accountKey === "string" && accountKeys.includes(p.accountKey)) out.accountKey = p.accountKey;
  return { ...out, ...deployPatch(p) };
}

/** The UI state from storage: valid values over the defaults, migrating older shapes. */
export function storedUi(raw: unknown): UiState {
  const stored = asRecord(raw);
  const valid = validPatch(stored, []);
  if (valid.author === "@other") delete valid.author;
  // accountKey is only used as a lookup key; keep it even before accounts load.
  if (typeof stored.accountKey === "string") valid.accountKey = stored.accountKey;
  // Before 0.8.0 there was only an "Add description" checkbox: it becomes the ticket format.
  if (!valid.copyFormat && stored.addDescription === true) valid.copyFormat = "ticket";
  return { ...DEFAULT_UI, ...valid };
}

const KEY = "ui";

/** The UI state, read once from storage and kept in memory; every change is saved. */
export class UiStateStore {
  private state?: UiState;

  constructor(private readonly store: KeyValueStore) {}

  get(): UiState {
    return (this.state ??= storedUi(this.store.get(KEY)));
  }

  async update(patch: Partial<UiState>): Promise<void> {
    this.state = { ...this.get(), ...patch };
    await this.store.set(KEY, this.state);
  }
}
