// @ts-check
// The only line to the extension: messages out, payload updates in. Nothing else calls acquireVsCodeApi.
(function () {
  /** @typedef {import('../src/core/protocol').Payload} Payload */

  /** @type {any} */
  const ns = ((/** @type {any} */ (window)).PrStatus ??= {});
  // @ts-ignore: provided by the VS Code webview
  const vscode = acquireVsCodeApi();

  /** @param {{ type: string, [k: string]: unknown }} msg */
  const send = (msg) => vscode.postMessage(msg);

  ns.bridge = {
    send,
    /** @param {Record<string, unknown>} patch */
    setState: (patch) => send({ type: 'setState', patch }),
    /** @param {string} url */
    open: (url) => send({ type: 'open', url }),
    /** Calls `fn` with every payload the extension sends. @param {(p: Payload) => void} fn */
    onUpdate(fn) {
      window.addEventListener('message', (e) => { if (e.data?.type === 'update') fn(e.data.payload); });
    },
  };
})();
