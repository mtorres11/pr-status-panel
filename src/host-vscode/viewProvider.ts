// The webview view: loads the page, forwards its messages and VS Code events to the panel, and refreshes on
// a timer while the panel is visible and VS Code is focused.

import { randomBytes } from "crypto";
import * as vscode from "vscode";
import type { Panel } from "../core/panel";
import { CFG } from "./vscodeAdapters";

/** Webview scripts in load order: shared helpers and the bridge first, the page last. */
const SCRIPTS = ["dom.js", "bridge.js", "prCard.js", "deploy.js", "main.js"];

export class PrStatusViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: Panel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      vscode.authentication.onDidChangeSessions(() => void panel.refreshActive(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CFG) && panel.settingsChanged()) this.schedule();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) panel.refreshIfStale();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this.html(view.webview, mediaRoot);
    this.panel.attach({ post: (message) => void view.webview.postMessage(message) });
    view.webview.onDidReceiveMessage((m: unknown) => this.panel.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(
      () => {
        if (view.visible) this.panel.refreshIfStale();
      },
      undefined,
      this.disposables,
    );
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.panel.detach();
      },
      undefined,
      this.disposables,
    );
    this.schedule();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.view?.visible && vscode.window.state.focused) void this.panel.refreshActive(false);
    }, this.panel.refreshIntervalMs);
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = randomBytes(24).toString("base64url");
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file));
    const scripts = SCRIPTS.map((f) => `<script nonce="${nonce}" src="${uri(f)}"></script>`).join("\n");
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri("main.css")}">
<title>PR Status</title>
</head><body>
<div id="app"></div>
${scripts}
</body></html>`;
  }
}
