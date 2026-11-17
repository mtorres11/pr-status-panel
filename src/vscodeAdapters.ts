// The VS Code side of the ports: the only place that turns core requests into VS Code API calls.

import * as vscode from "vscode";
import type { Auth, HostUi, KeyValueStore, Settings } from "./ports";

/** This extension's settings section. */
export const CFG = "prStatus";

/** Dialogs and notifications; `extensionId` scopes "open settings" to this extension. */
export const vscodeUi = (extensionId: string): HostUi => ({
  async confirm(message, detail, action) {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  },
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: (message) => void vscode.window.showWarningMessage(message),
  error: (message) => void vscode.window.showErrorMessage(message),
  progress: async (title, task) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task),
  async copy(text, flash) {
    await vscode.env.clipboard.writeText(text);
    if (flash) vscode.window.setStatusBarMessage(`$(check) ${flash}`, 2500);
  },
  openUrl: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
  prompt: async (o) =>
    vscode.window.showInputBox({
      title: o.title,
      prompt: o.prompt,
      placeHolder: o.placeHolder,
      ignoreFocusOut: o.ignoreFocusOut,
      validateInput: o.validate,
    }),
  pick: async (items, placeHolder) => vscode.window.showQuickPick(items, { placeHolder }),
  runInTerminal(name, command) {
    const terminal = vscode.window.createTerminal({ name });
    terminal.show();
    terminal.sendText(command);
  },
  openSettings: (query) =>
    void vscode.commands.executeCommand("workbench.action.openSettings", query || `@ext:${extensionId}`),
});

export const vscodeSettings: Settings = {
  get: (key, fallback) => vscode.workspace.getConfiguration(CFG).get(key, fallback),
  user<T>(key: string, fallback: T, section = CFG): T {
    const v = vscode.workspace.getConfiguration(section).inspect<T>(key)?.globalValue;
    return v === undefined || v === null ? fallback : v;
  },
  async update(key, value) {
    await vscode.workspace.getConfiguration(CFG).update(key, value, vscode.ConfigurationTarget.Global);
  },
};

export const vscodeAuth: Auth = {
  accounts: async (providerId) => [...(await vscode.authentication.getAccounts(providerId))],
  // getSession's overloads differ only by createIfNone; the options object has the same shape for all of them.
  session: async (providerId, scopes, options) =>
    vscode.authentication.getSession(providerId, scopes, options as vscode.AuthenticationGetSessionOptions),
};

/** The extension's global state (kept across windows and restarts). */
export function mementoStore(memento: vscode.Memento): KeyValueStore {
  return {
    get: (key) => memento.get(key),
    set: async (key, value) => memento.update(key, value),
  };
}
