// What the core needs from the editor it runs in. Only the VS Code adapter implements these, so the rest of
// the extension can be tested without VS Code.

import type { HostMessage } from "./protocol";

export interface PromptOptions {
  title?: string;
  prompt: string;
  placeHolder: string;
  /** Keep the box open when focus moves elsewhere. */
  ignoreFocusOut?: boolean;
  /** An error message for an invalid value, or undefined when it is fine. */
  validate(value: string): string | undefined;
}

/** Notifications, dialogs, clipboard, browser and terminal. */
export interface HostUi {
  /** A modal question with one action; true when the user picks it. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Runs `task` while a progress notification titled `title` is shown. */
  progress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /** Puts `text` on the clipboard; `flash`, when given, shows briefly in the status bar. */
  copy(text: string, flash?: string): Promise<void>;
  /** Opens an https link in the browser. */
  openUrl(url: string): void;
  prompt(options: PromptOptions): Promise<string | undefined>;
  pick<T extends { label: string }>(items: T[], placeHolder: string): Promise<T | undefined>;
  /** Runs a command line in a new, visible terminal. */
  runInTerminal(name: string, command: string): void;
  /** Opens the Settings editor filtered by `query`; "" shows all of this extension's settings. */
  openSettings(query: string): void;
}

/** This extension's settings. */
export interface Settings {
  /** The effective value (user, workspace or folder level). */
  get<T>(key: string, fallback: T): T;
  /**
   * The user-level value only, for anything that runs a program, picks an account or decides where a token
   * is sent: a cloned workspace's settings must never change those. `section` defaults to this extension's.
   */
  user<T>(key: string, fallback: T, section?: string): T;
  /** Saves a value at the user level. */
  update(key: string, value: unknown): Promise<void>;
}

export interface AuthAccount {
  id: string;
  label: string;
}

export interface AuthSession {
  accessToken: string;
  account: AuthAccount;
}

export interface SessionOptions {
  account?: AuthAccount;
  /** Ask the user to sign in when there is no session. */
  createIfNone?: boolean;
  /** Let the user choose another account than the remembered one. */
  clearSessionPreference?: boolean;
  /** Never prompt. */
  silent?: boolean;
}

/** The editor's built-in sign-in providers (GitHub, GitHub Enterprise). */
export interface Auth {
  accounts(providerId: string): Promise<AuthAccount[]>;
  session(providerId: string, scopes: string[], options: SessionOptions): Promise<AuthSession | undefined>;
}

/** Small persistent storage for the UI state. */
export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
}

/** The webview the panel draws in. */
export interface PanelView {
  post(message: HostMessage): void;
}
