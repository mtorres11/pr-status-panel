// Reads settings from the user level only. Used for anything that runs a program, picks an account or decides
// where a token is sent: workspace and folder values are ignored on purpose, so a cloned repository's
// .vscode/settings.json can never change them.

import * as vscode from "vscode";

/** This extension's settings section. */
export const CFG = "prStatus";

/** The user-level value of `section.key`, or `fallback` when it is not set there. */
export function userSetting<T>(key: string, fallback: T, section = CFG): T {
  const v = vscode.workspace.getConfiguration(section).inspect<T>(key)?.globalValue;
  return v === undefined || v === null ? fallback : v;
}
