// What the user can do with the PRs on screen: copy links, re-run checks, update a branch, set up Jira links,
// star a repo. Every request from the webview is checked against the extension's own PR data.

import { CopyFormat, CopyGroup, copyText, inGroup } from "./copy";
import type { ApiTarget } from "./github";
import type { PrClient, UpdateMethod } from "./githubPrs";
import type { PrView } from "./model";
import type { HostUi, Settings } from "./ports";
import { jiraOrigin, ticketUrl } from "./ticketLinks";
import { isHttpsUrl } from "./validate";

/** How long GitHub needs to queue re-run jobs, or to register an updated branch, before a refresh shows it. */
const RERUN_SETTLE_MS = 5000;
const UPDATE_SETTLE_MS = 4000;

const COPIED_AS: Record<CopyFormat, string> = {
  links: "",
  ticket: " with tickets and titles",
  markdown: " as a Markdown list",
};

export interface PrActionsDeps {
  ui: HostUi;
  settings: Settings;
  client: PrClient;
  /** PRs from the last refresh. */
  prs: { find(id: string): PrView | undefined; pick(ids: string[]): PrView[] };
  /** The signed-in API, or undefined when signed out. */
  github: () => Promise<ApiTarget | undefined>;
  /** Refresh after `ms` milliseconds. */
  refreshSoon: (ms: number) => void;
}

const hasSafeLinks = (p: PrView) => isHttpsUrl(p.url) && (!p.ticketUrl || isHttpsUrl(p.ticketUrl));

export class PrActions {
  constructor(private readonly deps: PrActionsDeps) {}

  /** Copies one PR or ticket link. The URL comes from our own PR data, never from the webview message. */
  async copyUrl(prId: string, which: "pr" | "ticket"): Promise<void> {
    const pr = this.deps.prs.find(prId);
    const url = which === "ticket" ? pr?.ticketUrl : pr?.url;
    if (!pr || !isHttpsUrl(url)) return;
    await this.deps.ui.copy(url, `Copied ${which === "ticket" ? `${pr.ticket} link` : `PR #${pr.number} link`}`);
  }

  /**
   * Copies the links of the shown PRs in one group, in the order shown. Every id is checked
   * against the group again here, so the panel can never copy PRs outside it.
   */
  async copyLinks(ids: string[], group: CopyGroup, format: CopyFormat): Promise<void> {
    const prs = this.deps.prs.pick(ids).filter((p) => inGroup(p, group) && hasSafeLinks(p));
    if (!prs.length) {
      this.deps.ui.info("PR Status: no PRs in this group in the list.");
      return;
    }
    await this.deps.ui.copy(copyText(prs, format, group === "all"));
    this.deps.ui.info(`PR Status: copied ${prs.length} PR link${prs.length === 1 ? "" : "s"}${COPIED_AS[format]}.`);
  }

  /** Re-runs the failed jobs (or all jobs) of the GitHub Actions runs behind a PR's checks, after confirming. */
  async rerun(prId: string, failedOnly: boolean): Promise<void> {
    const pr = this.deps.prs.find(prId);
    if (!pr) return;
    // "failed" needs a failed Actions run; "all" works for any PR with Actions runs, failing or not.
    const runIds = failedOnly ? pr.rerun.failedRunIds : pr.rerun.allRunIds;
    if (!runIds.length) return this.deps.ui.warn(nothingToRerun(pr, failedOnly));
    const what = failedOnly ? "the failed jobs" : "all jobs";
    const asked = `Re-run ${what} in ${runIds.length} workflow run(s) for ${pr.repo}#${pr.number}?`;
    if (!(await this.deps.ui.confirm(asked, pr.title, failedOnly ? "Re-run failed" : "Re-run all"))) return;
    const api = await this.signedIn();
    if (!api) return;
    const errors: string[] = [];
    await this.deps.ui.progress(`Re-running checks for #${pr.number}…`, async () => {
      for (const id of runIds)
        await this.deps.client.rerun(api, pr.repo, id, failedOnly).catch((e: Error) => errors.push(`run ${id}: ${e.message}`));
    });
    this.reportRerun(pr, runIds.length, errors);
    this.deps.refreshSoon(RERUN_SETTLE_MS);
  }

  /** Brings a PR branch up to date with its base (GitHub's "Update branch"), after confirming. */
  async updateBranch(prId: string, method: UpdateMethod): Promise<void> {
    const pr = this.deps.prs.find(prId);
    if (!pr) return;
    if (!pr.canUpdateBranch)
      return this.deps.ui.info(`PR Status: #${pr.number} is up to date with ${pr.baseRef}, or you can't push to its branch.`);
    const rebase = method === "REBASE";
    const asked = `${rebase ? "Rebase" : "Update"} ${pr.repo}#${pr.number} onto the latest ${pr.baseRef}?`;
    if (!(await this.deps.ui.confirm(asked, updateDetail(pr, rebase), rebase ? "Rebase branch" : "Update branch"))) return;
    const api = await this.signedIn();
    if (!api) return;
    try {
      await this.deps.ui.progress(`Updating #${pr.number} with ${pr.baseRef}…`, () =>
        this.deps.client.updateBranch(api, pr.id, pr.headOid, method),
      );
      this.deps.ui.info(`PR Status: #${pr.number} is now up to date with ${pr.baseRef}.`);
    } catch (e) {
      this.deps.ui.error(updateFailed(pr, (e as Error).message));
    }
    this.deps.refreshSoon(UPDATE_SETTLE_MS);
  }

  /** Saves the Jira site for ticket links, then opens the ticket that was clicked. */
  async configureJira(ticket: string): Promise<void> {
    const input = await this.deps.ui.prompt({
      title: "PR Status: Jira site for ticket links",
      prompt: "Paste your Jira site or any Jira link (e.g. your board URL). Only the site part is kept.",
      placeHolder: "https://yourcompany.atlassian.net",
      ignoreFocusOut: true,
      validate: (v) => (jiraOrigin(v) ? undefined : "Enter a valid Jira URL"),
    });
    const origin = jiraOrigin(input ?? "");
    if (!origin) return;
    await this.deps.settings.update("jiraBaseUrl", origin);
    const url = ticketUrl(origin, ticket);
    if (url && /^[A-Za-z0-9_-]{1,64}$/.test(ticket)) this.deps.ui.openUrl(url);
  }

  /** Stars or un-stars a repo in the favorites setting. */
  async toggleFavorite(repo: string): Promise<void> {
    const favs = new Set(this.deps.settings.get<string[]>("favoriteRepos", []));
    if (!favs.delete(repo)) favs.add(repo);
    await this.deps.settings.update("favoriteRepos", [...favs].sort());
  }

  private async signedIn(): Promise<ApiTarget | undefined> {
    const api = await this.deps.github();
    if (!api) this.deps.ui.error("PR Status: sign in to GitHub first.");
    return api;
  }

  private reportRerun(pr: PrView, total: number, errors: string[]): void {
    const restarted = total - errors.length;
    if (errors.length) return this.deps.ui.error(`PR Status: ${restarted} of ${total} run(s) restarted. ${errors.join("; ")}`);
    const skipped = pr.rerun.failedExternal
      ? ` ${pr.rerun.failedExternal} failing non-Actions check(s) were skipped.`
      : "";
    this.deps.ui.info(`PR Status: restarted ${restarted} workflow run(s) for #${pr.number}.${skipped}`);
  }
}

function nothingToRerun(pr: PrView, failedOnly: boolean): string {
  return failedOnly
    ? `PR Status: none of the failing checks on #${pr.number} are GitHub Actions workflows yet. Try Re-run all checks.`
    : `PR Status: no GitHub Actions workflows are behind the checks on #${pr.number}, so nothing can be re-run from here.`;
}

function updateDetail(pr: PrView, rebase: boolean): string {
  return [
    pr.title,
    "",
    rebase
      ? `Replays the branch's commits on top of ${pr.baseRef}. This rewrites the branch: anyone with a local copy must reset it (for example git pull --rebase).`
      : `Merges ${pr.baseRef} into the branch with a merge commit, like GitHub's Update branch button.`,
    "Checks will run again. If the repository dismisses stale approvals, existing approvals are removed.",
  ].join("\n");
}

function updateFailed(pr: PrView, message: string): string {
  return /expected head|head sha|not match/i.test(message)
    ? `PR Status: #${pr.number} changed since the last refresh, so it was not updated. The list is refreshing; try again.`
    : `PR Status: could not update #${pr.number}: ${message}`;
}
