# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub: **Security** tab → **Report a vulnerability**
(<https://github.com/mtorres11/pr-status-panel/security/advisories/new>).
You'll get a response as soon as possible, and a fix will be released before details are made public.

## How the extension handles your data

Full details: [docs/SECURITY_ASSESSMENT.md](docs/SECURITY_ASSESSMENT.md).

- It never stores a GitHub token. It uses VS Code's built-in GitHub sign-in (`repo`, `read:org` scopes) and asks VS Code for a session on each refresh.
- It only talks to the GitHub API (`api.github.com`, or your GitHub Enterprise server if you configure one). Links to Jira and GitHub open in your browser.
- The panel runs in a locked-down webview (no remote scripts, a strict Content Security Policy, no inline scripts or styles).
- Re-running checks always asks for confirmation first.

## Verifying a release

Every release `.vsix` is built by GitHub Actions from a tagged commit and has a signed build-provenance attestation:

```
gh attestation verify pr-status-panel.vsix --repo mtorres11/pr-status-panel
```

`SHA256SUMS.txt` on each release lists the file's checksum.
