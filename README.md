# PR Status Panel

VS Code sidebar showing your open GitHub pull requests with three live bars per PR:
**Checks** (passed/total), **Comments** (resolved/total review comments) and **Approvals** (approved/required).

Created by **Marco Torres C** · <https://github.com/mtorres11/pr-status-panel>

## Install

Full step-by-step guide (macOS, Windows, Linux, troubleshooting): **[docs/INSTALL.md](docs/INSTALL.md)**.

**From the VS Code Marketplace** (recommended, updates automatically): open the Extensions view
(**Cmd/Ctrl+Shift+X**), search **PR Status Panel**, click **Install**. Or from a terminal:

```
code --install-extension mtorres11.pr-status-panel
```

**From GitHub Releases** with one command (needs the [GitHub CLI](https://cli.github.com/)):

```
gh release download --repo mtorres11/pr-status-panel --pattern '*.vsix' --dir /tmp --clobber
code --install-extension /tmp/pr-status-panel.vsix --force
```

**Or by hand from GitHub:** download `pr-status-panel.vsix` from the [latest release](https://github.com/mtorres11/pr-status-panel/releases/latest),
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
| Share | **⧉ Copy …** copies the links of the listed PRs in one group, in list order. The button copies your last group; **▾** picks another (see below). |
| Format | How the copied text looks: **Links**, **Ticket + title + link** or **Markdown list** (see below). |

## Copy links

**Groups** (the ▾ next to the Copy button). Each one shows how many listed PRs it has, and is greyed out when there are none.
The filters above (account, author, repo, show, drafts) always apply.

| Group | Copies |
| --- | --- |
| Needing approval | Not fully approved yet and not in the merge queue |
| Ready to merge | Everything green and approved |
| Failing checks | At least one check failing |
| Changes requested | A reviewer asked for changes |
| Checks running | Checks still running |
| Drafts | Draft PRs |
| Behind base branch | Can be updated with its base branch (see ⚙) |
| In merge queue | Already queued to merge |
| All shown | Every listed PR, in sections per status (*Checks failing (2)*, *Ready to merge (1)*, …) |

**Formats:**

| Format | Each PR looks like |
| --- | --- |
| Links | `https://github.com/org/repo/pull/12` |
| Ticket + title + link | `PROJ-123 · Title` / `Jira: <ticket link>` / `PR: <PR link>`, with a blank line between PRs |
| Markdown list | `- [PROJ-123](<ticket link>) [Title](<PR link>)` |

PRs without a ticket, and chores (titles starting with `[CHORE]`), are copied without one. The Jira line needs
**Jira site** to be set. If you had ticked **Add description** before, your format starts as **Ticket + title + link**.


Each card has a **⧉** copy icon next to the PR title (copies the PR URL) and, when a Jira site is configured, next to the ticket key (copies the ticket URL). The icon turns into ✓ for a moment after copying.

## Per-PR options (⚙)

The gear at the top right of each card opens a menu:

- **Re-run failed checks**: re-runs only the failed jobs of the GitHub Actions runs behind the PR.
- **Re-run all checks**: re-runs every job in those runs.
- **Update branch (merge main)**: merges the latest base branch into the PR branch, like GitHub's **Update branch** button.
- **Update branch (rebase)**: replays the PR branch on top of the latest base branch. This rewrites the branch, so local copies need a `git pull --rebase`.

**Re-run failed checks** is enabled when at least one failed check is a GitHub Actions job. **Re-run all checks** is
enabled whenever the PR has GitHub Actions runs, failing or not, so a failure from another system (for example AWS
CodeBuild) can be re-triggered by re-running the workflow behind it. Each re-run asks for confirmation first.

**Branch behind its base:** when a PR's branch is behind its base branch and you can update it, the card shows a small
**⤓ behind** label next to the repo name and a dot on ⚙ (compact mode shows only the dot). The update items are enabled
only then. Otherwise they explain why not, for example *Merge conflicts: resolve them locally first*. Updating asks for
confirmation, makes the checks run again, and may remove approvals if the repository dismisses stale reviews. If someone
pushed to the branch since the last refresh, GitHub refuses the update instead of overwriting their work. Drafts and
PRs already in the merge queue never show the label.

The **Comments** bar shows resolved review threads in green and unresolved ones in yellow.

Under each card, collapsible lists show what needs attention. Each opens on its own:

- **N check(s) not passing**: failed, running and pending checks, each linking to its run.
- **N comment(s) unresolved**: each open review thread with its author, file and line, and the start of the comment,
  linking to the thread.
- **N approval(s) missing / requested changes**: reviewers who requested changes, reviewers still asked to review,
  and who approved. When nothing is missing it reads **N approval(s)** and lists the approvers.

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

No telemetry: the extension collects no usage data. Install counts are only what the Marketplace and GitHub Releases show.
