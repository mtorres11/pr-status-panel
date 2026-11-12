# Installing PR Status Panel

This guide takes about 2 minutes. It works on macOS, Windows and Linux.

## Requirements

- **VS Code 1.95 or newer**: *Code → About* (macOS) or *Help → About* (Windows/Linux).
- **A GitHub account** with access to the repositories whose pull requests you want to see.
- Optional: the [GitHub CLI (`gh`)](https://cli.github.com/), for the one-command install and for verifying downloads.

## 1. Install the extension

### Option A: VS Code Marketplace (recommended)

1. Open the **Extensions** view (**Cmd/Ctrl+Shift+X**).
2. Search **PR Status Panel** (publisher **mtorres11**) and click **Install**.

Or from a terminal: `code --install-extension mtorres11.pr-status-panel`

Marketplace installs update automatically.

### Option B: GitHub Releases, one command

macOS / Linux (bash, zsh or fish):

```
gh release download --repo mtorres11/pr-status-panel --pattern '*.vsix' --dir /tmp --clobber
code --install-extension /tmp/pr-status-panel.vsix --force
```

Windows (PowerShell):

```
gh release download --repo mtorres11/pr-status-panel --pattern '*.vsix' --dir $env:TEMP --clobber
code --install-extension "$env:TEMP\pr-status-panel.vsix" --force
```

> `code: command not found`? In VS Code press **Cmd/Ctrl+Shift+P** and run
> **Shell Command: Install 'code' command in PATH** (macOS), or reinstall VS Code with
> "Add to PATH" checked (Windows). Then open a new terminal.

### Option C: GitHub Releases, by hand (no command line)

1. Open the [latest release](https://github.com/mtorres11/pr-status-panel/releases/latest)
   and download **`pr-status-panel.vsix`**.
2. In VS Code open the **Extensions** view (**Cmd/Ctrl+Shift+X**).
3. Click **`…`** (top right of the Extensions view) → **Install from VSIX…** and pick the file.

### Optional: verify the download

Each release is built by this repo's GitHub Actions and carries a signed
[build-provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations).
To confirm your file is exactly what CI built from the public source:

```
gh attestation verify /tmp/pr-status-panel.vsix --repo mtorres11/pr-status-panel
```

You can also compare the file's SHA-256 with `SHA256SUMS.txt` on the release page
(`shasum -a 256 pr-status-panel.vsix` on macOS/Linux, `Get-FileHash pr-status-panel.vsix` on Windows).

## 2. Open it

1. **Cmd/Ctrl+Shift+P → Developer: Reload Window**.
2. **Cmd/Ctrl+Shift+P → View: Show PR Status**, or click the pull-request icon in the
   Activity Bar (the column of icons on the far left).
3. When VS Code asks *"The extension 'PR Status Panel' wants to sign in using GitHub"*, click **Allow**
   and choose your account. (No pop-up? Click **Sign in to GitHub** inside the panel.)

**Keep it on the right side:** right-click the PR Status icon → **Move To → Secondary Side Bar**,
or drag the icon to the right edge of the window. Toggle the right sidebar with **Cmd+Option+B** (macOS) / **Ctrl+Alt+B**.

## 3. Recommended settings

Open **Cmd/Ctrl+,** (Settings), search **prStatus**, or click the ⚙ at the top of the panel.

| Setting | Why |
|---|---|
| `prStatus.organizations` | Limits "All repos" to your organizations, e.g. `["my-org"]`. Recommended if you can see many repos. |
| `prStatus.jiraBaseUrl` | Makes ticket keys clickable, e.g. `https://yourcompany.atlassian.net`. You can paste any Jira link; only the site part is kept. Or just click a ticket key and the panel asks for it. |
| `prStatus.teamMembers` | GitHub usernames to pick in the **Author** dropdown. |

Example (user `settings.json`):

```json
"prStatus.organizations": ["my-org"],
"prStatus.jiraBaseUrl": "https://yourcompany.atlassian.net",
"prStatus.teamMembers": ["teammate-1", "teammate-2"]
```

All `prStatus.*` settings are **user-level only**: a repository's `.vscode/settings.json` cannot change them.

**GitHub Enterprise Server:** add `"github-enterprise.uri": "https://github.example.com"` (https only) to your
*user* settings. Enterprise accounts then appear in the **Account** dropdown.

## 4. Multiple GitHub accounts

Use **Account → ＋ Add another account…** in the panel. Every account you sign in to VS Code
(Accounts menu, bottom left) is listed; switch with one click. Sign-out is done from VS Code's Accounts menu.

## Updating

Marketplace installs update automatically. For GitHub Releases installs, run the same command again (Option B) or install the newer `.vsix` by hand. Your settings are kept.

## Uninstalling

Extensions view → **PR Status Panel** → **Uninstall**, or:

```
code --uninstall-extension mtorres11.pr-status-panel
```

To also revoke its GitHub access: VS Code Accounts menu → your GitHub account → **Manage Trusted Extensions**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says **Sign in to GitHub** | Click it and approve the sign-in. If it keeps asking, sign out of GitHub in the Accounts menu and sign in again. |
| A repo or PR is missing | Your organization may require SSO authorization: open github.com → *Settings → Applications → Authorized OAuth Apps → Visual Studio Code* and **Grant** access to the org. Also check `prStatus.organizations`. |
| Approvals show the wrong "required" number | Set `prStatus.requiredApprovalsPerRepo`, e.g. `{"my-org/my-repo": 2}`. |
| Ticket key not detected | Adjust `prStatus.ticketPattern` (regex matched on the branch name, then the title). |
| Re-run buttons are greyed out | They only enable when a check has failed and it comes from GitHub Actions. |
| Anything else | Open an [issue](https://github.com/mtorres11/pr-status-panel/issues). Security problems: see [SECURITY.md](../SECURITY.md). |
