# Security Assessment: PR Status Panel

| | |
|---|---|
| Version assessed | 0.5.0 |
| Date | 2026-11-12 |
| Scope | Extension source (`src/`, `media/`), manifest, build/release pipeline, dependencies, repository controls |
| Result | No open high or medium findings. 0 known dependency vulnerabilities. No runtime dependencies. |

## 1. What the extension does

A VS Code sidebar that lists the signed-in user's open GitHub pull requests with check, review-comment and approval status,
and can re-run failed GitHub Actions jobs after explicit confirmation.

## 2. Architecture and data flow

```
 ┌──────────────── VS Code ────────────────────────────────────────┐
 │                                                                 │
 │  Webview (panel UI)            Extension host (Node)            │
 │  media/main.js  ── postMessage ──▶  src/extension.ts            │
 │  · no network access             · validates every message      │
 │  · strict CSP, nonce script      · builds GitHub queries        │
 │  · DOM built with textContent    · src/github.ts (fetch, 20s    │
 │                                    timeout)                     │
 │                                         │                       │
 │  VS Code GitHub sign-in ◀── getSession ─┘ (token in memory only)│
 └─────────────────────────────────────────┼───────────────────────┘
                                           │ HTTPS, Bearer token
                                           ▼
             api.github.com  (or the user's own https GitHub Enterprise host)

 Browser ◀── openExternal (https links only: PR, check run, Jira ticket)
```

| Data | Where it lives | Leaves the machine? |
|---|---|---|
| GitHub OAuth token | VS Code's secret storage (owned by VS Code, not this extension); held in memory per request | Only to the GitHub API host |
| PR/check/review data | Extension memory | No |
| UI selections (account, filters) | VS Code `globalState` on the local machine | No |
| Settings (favorites, Jira site, …) | User settings (synced only if the user enabled Settings Sync) | Only via the user's own Settings Sync |
| Clipboard | PR titles and URLs, written only when the user clicks **Copy PR links** or a ⧉ copy icon (text built in the extension host from GitHub data; https URLs only) | Only where the user pastes it |
| Telemetry / analytics | None collected | No |

**Network destinations:** `api.github.com` (GraphQL + REST), or `https://<github-enterprise.uri>/api/...` when configured.
Nothing else. The Jira site is only opened in the user's browser and is never called by the extension.

**Permissions requested:** OAuth scopes `repo` (needed to read private repositories' PRs and checks and to re-run workflows)
and `read:org` (organization membership for search). These are requested through VS Code's built-in GitHub
authentication; the extension never sees a password and never stores a token.

## 3. Threat model and controls

| Threat | Control |
|---|---|
| **Token sent to an attacker's server** | Token only sent to `api.github.com` or to the origin of the user-level `github-enterprise.uri` (https enforced; workspace values ignored). No custom API URL setting exists. |
| **Malicious repository changes extension settings** (`.vscode/settings.json`) | Every `prStatus.*` setting is `application`-scoped (user level only), so workspace values are ignored. Enterprise URL read from `inspect().globalValue` only. |
| **XSS in the panel from PR titles, branch names, check names** | Panel builds DOM with `textContent` / `createElement` only (no `innerHTML`). CSP: `default-src 'none'`, scripts only by nonce (`crypto.randomBytes`), styles only from the extension. No remote content is loaded. |
| **Forged messages from the webview** | Every message is validated in the extension host: enum allow-lists, GitHub login and repo-name patterns, account keys must match a real signed-in account, unknown keys dropped. |
| **Search-query or URL injection** | Logins and repos validated against GitHub's character rules before going into search queries; REST path segments URL-encoded; `.`/`..` repo names rejected; ticket keys URL-encoded. |
| **Opening dangerous links** | `openExternal` only accepts `https:` URLs (blocks `http:`, `file:`, `javascript:`, `vscode:` and other schemes). |
| **Accidental CI re-runs** | Buttons are disabled unless a check failed; a modal confirmation names the repo, PR and number of runs; re-runs use the PR's own workflow run IDs from GitHub. |
| **Regex denial of service** (user-configured `ticketPattern`, `ignoredChecks`) | Invalid regexes are ignored; text fed to them is capped at 256 characters; patterns can only come from the user's own settings. |
| **Hung network calls** | All requests time out after 20 s; overlapping refreshes are cancelled by a generation counter. |
| **Rate-limit abuse** | Refresh ≥ 15 s (default 60 s), paused when VS Code is unfocused or the panel hidden; search capped at 4 pages; branch rules cached 1 h, repo list 30 min. |

## 4. Findings fixed during this assessment

| ID | Severity | Finding | Fix |
|---|---|---|---|
| S1 | High | A workspace setting (`prStatus.enterpriseUri`) could point API calls, and a GitHub Enterprise token, at any host, including over `http`. | Setting removed; host taken only from the user-level `github-enterprise.uri`, https enforced, origin only. |
| S2 | Medium | Settings (Jira link target, regex patterns) could be set by a cloned repository. | All settings `application`-scoped. |
| S3 | Medium | Webview messages were not validated. | Strict allow-list validation (`src/validate.ts`). |
| S4 | Low | `http://` links could be opened. | https only. |
| S5 | Low | CSP nonce used `Math.random`. | `crypto.randomBytes`. |
| S6 | Low | Ticket keys and repo names were not URL-encoded. | Encoded; dot-segment repo names rejected. |
| S7 | Low | No request timeout. | 20 s `AbortSignal.timeout`. |

## 5. Dependencies

- **Runtime dependencies: none.** The packaged `.vsix` contains only this repo's compiled code, styles, icon, README and LICENSE (no `node_modules`, no source maps).
- **Build-time only** (never shipped): `typescript`, `@types/node`, `@types/vscode`, `@vscode/vsce` 4.x (with `minimatch` pinned to a patched 11.x through `overrides`).
- `npm audit`: **0 vulnerabilities** at the time of assessment.
- All packages resolve from the public `registry.npmjs.org`; `package-lock.json` is committed.
- Install scripts are disabled in CI (`npm ci --ignore-scripts`).
- Dependabot opens weekly update PRs for npm packages and GitHub Actions.

## 6. Build and release (supply chain)

- Releases are built **only** by GitHub Actions from a pushed `v*` tag; the job fails if the tag differs from `package.json`'s version.
- Third-party actions are pinned to full commit SHAs.
- Workflows default to `contents: read`; only the release job gets `contents: write` + `id-token: write` + `attestations: write`.
- `actions/checkout` runs with `persist-credentials: false`.
- Each release carries a signed **build-provenance attestation** (Sigstore) and `SHA256SUMS.txt`, so users can verify the file with `gh attestation verify`.

## 7. Repository controls

- Only the owner can push. Everyone else contributes by fork + pull request.
- `main` is protected by a ruleset: pull request required, code-owner review required, CI must pass, no force-push, no deletion. Only the repository owner can bypass.
- Release tags (`v*`) can only be created, changed or deleted by the owner.
- Workflows from outside contributors' PRs need the owner's approval before they run.
- The default workflow token is read-only and cannot approve pull requests.
- Secret scanning + push protection, Dependabot alerts + security updates, CodeQL code scanning, and private vulnerability reporting are enabled.

## 8. Residual risks (accepted)

- **The `repo` scope is broad.** GitHub OAuth has no narrower read-only scope for private repositories. Mitigation: the token is VS Code's and is used only for the calls listed above. Users can revoke access from the VS Code Accounts menu or GitHub settings.
- **Check-run links come from third-party CI apps** and may point to any https site. They are opened in the browser only when the user clicks them.
- **No automatic updates.** Users must reinstall to get fixes. Releases are announced in the repository.
- **User-supplied regexes** in user settings are trusted as the user's own input; the length cap limits, but cannot fully remove, backtracking cost.

## 9. How to re-run this assessment

```
npm ci --ignore-scripts
npm audit
npx tsc -p ./
npm run package && unzip -l pr-status-panel.vsix
```
