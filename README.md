# PR Status Panel

VS Code sidebar showing your open GitHub pull requests with three live bars per PR:
**Checks** (passed/total), **Comments** (resolved/total review comments) and **Approvals** (approved/required).

Created by **Marco Torres C** · <https://github.com/mtorres11/pr-status-panel>

## Install

Full step-by-step guide (macOS, Windows, Linux, troubleshooting): **[docs/INSTALL.md](docs/INSTALL.md)**.

**One command** (needs the [GitHub CLI](https://cli.github.com/); also works for updates):

```
gh release download --repo mtorres11/pr-status-panel --pattern '*.vsix' --dir /tmp --clobber
code --install-extension /tmp/pr-status-panel.vsix --force
```

**Or by hand:** download `pr-status-panel.vsix` from the [latest release](https://github.com/mtorres11/pr-status-panel/releases/latest),
then in VS Code: Extensions view → `…` → **Install from VSIX…**.

Then:

1. **Cmd/Ctrl+Shift+P → Reload Window**.
2. **Cmd/Ctrl+Shift+P → View: Show PR Status**, or click the PR Status icon in the Activity Bar.
3. Allow the GitHub sign-in when VS Code asks.
4. Optional: right-click the icon → **Move To → Secondary Side Bar** to keep it on the right.

Optional (verify the download was built by this repo's CI):

```
gh attestation verify /tmp/pr-status-panel.vsix --repo mtorres11/pr-status-panel
```

## Top bar

| Control | What it does |
|---|---|
| Account | Any GitHub account signed in to VS Code (Accounts menu). "Add another account…" signs in a new one. |
| Author | Me, a teammate from `prStatus.teamMembers`, the whole team, or any username. |
| Repo | All repos, or one repo (searchable). Click ☆ next to a repo to add it to **Favorites** (listed right after *All repos*); click ★ to remove it. |
| Show | Authored / Review requested / Assigned / All. Drafts on/off. Sort by attention, last updated or ticket. |
| Share | **Copy PR links** copies the links of the listed PRs that still need approval (skips fully approved PRs and PRs in the merge queue), in list order. Tick **Add description** to put each PR's title above its link, with a blank line between PRs. |

## Copy links

Each card has a **⧉** copy icon next to the PR title (copies the PR URL) and, when a Jira site is configured, next to the ticket key (copies the ticket URL). The icon turns into ✓ for a moment after copying.

## Per-PR options (⚙)

The gear at the top right of each card opens a menu:

- **Re-run failed checks**: re-runs only the failed jobs of the GitHub Actions runs behind the PR.
- **Re-run all checks**: re-runs every job in those runs.

Both are disabled when no check has failed, or when the failing checks are not GitHub Actions workflows. Each re-run asks for confirmation first.

## Settings (gear icon)

| Setting | Default | Notes |
|---|---|---|
| `prStatus.refreshIntervalSeconds` | 60 | Pauses while VS Code is unfocused or the panel is hidden. |
| `prStatus.organizations` | `[]` | Limit "All repos" and the repo list to these orgs. |
| `prStatus.favoriteRepos` | `[]` | Managed by the star in the repo dropdown. |
| `prStatus.teamMembers` | `[]` | Usernames for the Author dropdown. |
| `prStatus.jiraBaseUrl` | `""` | e.g. `https://yourcompany.atlassian.net` (any Jira link works); enables ticket links. If empty, clicking a ticket asks for it. |
| `prStatus.ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | Matched against branch name, then title. |
| `prStatus.requiredApprovals` | 1 | Fallback when the repo's rules can't be read. |
| `prStatus.requiredApprovalsPerRepo` | `{}` | Per-repo override. |
| `prStatus.ignoredChecks` | `[]` | Regexes of check names to leave out. |
| `prStatus.ignoreBotThreads` | false | Don't count bot-started review comments (e.g. Copilot). |
| `prStatus.groupByRepo` / `prStatus.compact` | false | Layout options. |

All settings are **user-level only**: a cloned repository's `.vscode/settings.json` cannot change them.

**GitHub Enterprise Server:** set VS Code's own `github-enterprise.uri` in your *user* settings (e.g. `"github-enterprise.uri": "https://github.example.com"`, https only). Enterprise accounts then appear in the Account dropdown.

Required approvals are read from the base branch's rulesets (`GET /repos/{repo}/rules/branches/{branch}`), then classic branch protection, then the fallback setting.

## Develop

Contributions are welcome through pull requests; see [CONTRIBUTING.md](CONTRIBUTING.md).


```
npm install
npm run compile      # or: npm run watch, then F5 in VS Code
npm run package      # builds pr-status-panel.vsix
```

No tokens are stored: authentication uses VS Code's built-in GitHub sign-in (`repo`, `read:org` scopes).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability, and [docs/SECURITY_ASSESSMENT.md](docs/SECURITY_ASSESSMENT.md) for the architecture, threat model, dependency review and repository controls.

## License

[MIT](LICENSE) © 2026 Marco Torres C
