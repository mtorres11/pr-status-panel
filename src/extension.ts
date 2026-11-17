// Activation: builds the panel with the VS Code adapters and registers the view and commands.

import * as vscode from "vscode";
import { aboutFrom } from "./about";
import { Panel } from "./panel";
import { PrStatusViewProvider } from "./viewProvider";
import { mementoStore, vscodeAuth, vscodeSettings, vscodeUi } from "./vscodeAdapters";

export function activate(context: vscode.ExtensionContext): void {
  const ui = vscodeUi(context.extension.id);
  const panel = new Panel({
    ui,
    settings: vscodeSettings,
    auth: vscodeAuth,
    store: mementoStore(context.globalState),
    about: aboutFrom(context.extension.packageJSON),
  });
  const provider = new PrStatusViewProvider(panel, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("prStatus.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("prStatus.refresh", () => panel.refreshActive(true)),
    vscode.commands.registerCommand("prStatus.addAccount", () => panel.signIn(true)),
    vscode.commands.registerCommand("prStatus.openSettings", () => ui.openSettings("")),
    provider,
  );
}

export function deactivate(): void {
  /* nothing */
}
