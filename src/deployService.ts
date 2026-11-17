// Loads the Deployments tab: PRs for the filters, their ticket, whether they are in the chosen branch,
// reverts, and for merged ones the CodePipeline stages that already contain them.

import { mapLimit } from "./async";
import { AwsConfig, AwsError } from "./awsCli";
import {
  BranchCommits,
  BranchIndex,
  DeployRawPr,
  getDeployPr,
  searchDeployPrs,
} from "./deployGithub";
import { DeployUi, fetchPlan, SearchContext } from "./deployFilters";
import {
  containsFn,
  findRevert,
  PipelineTrack,
  RevertInfo,
  trackFor,
} from "./deployLocation";
import type { ApiTarget } from "./github";
import { PipelineHistory, PipelineReader } from "./pipelines";
import { ticketsOf, ticketUrl } from "./ticketLinks";

const MAX_PRS = 100;
const DAY = 86_400_000;

export interface DeployPr {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  mergedBy?: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  reviewDecision?: string;
  ticket?: string;
  ticketUrl?: string;
  /** Whether the change is in the chosen branch; undefined when unknown. */
  inBranch?: boolean;
  revert?: RevertInfo;
  /** Pipelines that already have this change in at least one stage. */
  tracks: PipelineTrack[];
  /** All pipelines of the repo, so the panel can say "3 of 12 pipelines". */
  pipelineCount?: number;
}

export interface AwsStatus {
  state: "ok" | "off" | "signin" | "nocli" | "error";
  message?: string;
}

export interface DeployRequest {
  ui: DeployUi;
  api: ApiTarget;
  search: SearchContext;
  ticketPattern: string;
  jiraBaseUrl: string;
  /** Undefined when AWS is turned off in settings. */
  aws?: AwsConfig;
  pipelinePrefix: (repo: string) => string;
  ignoreStages?: RegExp;
}

export interface DeployResult {
  prs: DeployPr[];
  hint?: string;
  aws: AwsStatus;
}

interface RepoContext {
  idx?: BranchIndex;
  histories: PipelineHistory[];
}

export class DeployService {
  private readonly branches = new BranchCommits();
  private readonly reader = new PipelineReader();

  async load(req: DeployRequest): Promise<DeployResult> {
    const plan = fetchPlan(req.ui, req.search);
    if ("hint" in plan)
      return { prs: [], hint: plan.hint, aws: { state: "ok" } };
    const raws =
      "pr" in plan
        ? await this.one(req, plan.pr)
        : await this.search(req, plan.queries);
    const aws: AwsStatus = { state: req.aws ? "ok" : "off" };
    const repos = new Map<string, RepoContext>();
    for (const repo of new Set(raws.map((r) => r.repository.nameWithOwner))) {
      repos.set(repo, await this.repoContext(req, repo, raws, aws));
    }
    const prs = await mapLimit(raws, 4, (r) =>
      this.toPr(req, r, repos.get(r.repository.nameWithOwner) as RepoContext),
    );
    const hint =
      "pr" in plan && !raws.length
        ? `${plan.pr.repo}#${plan.pr.number} was not found, or this account cannot see it.`
        : undefined;
    return { prs, hint, aws };
  }

  private async one(
    req: DeployRequest,
    ref: { repo: string; number: number },
  ): Promise<DeployRawPr[]> {
    const pr = await getDeployPr(req.api, ref.repo, ref.number);
    return pr ? [pr] : [];
  }

  private async search(
    req: DeployRequest,
    queries: string[],
  ): Promise<DeployRawPr[]> {
    const pages = await mapLimit(queries, 3, (q) =>
      searchDeployPrs(req.api, q),
    );
    const unique = new Map(
      pages
        .flat()
        .filter((p) => p.state !== "CLOSED")
        .map((p) => [p.id, p]),
    );
    const when = (p: DeployRawPr) => p.mergedAt ?? p.updatedAt;
    return [...unique.values()]
      .sort((a, b) => when(b).localeCompare(when(a)))
      .slice(0, MAX_PRS);
  }

  /** Branch history from just before the oldest merge, and the repo's pipelines (when AWS is on). */
  private async repoContext(
    req: DeployRequest,
    repo: string,
    raws: DeployRawPr[],
    aws: AwsStatus,
  ): Promise<RepoContext> {
    const merged = raws
      .filter((r) => r.repository.nameWithOwner === repo && r.mergedAt)
      .map((r) => r.mergedAt as string);
    const oldest = Math.min(
      Date.now() - req.ui.deployWhen * DAY,
      ...merged.map((d) => Date.parse(d)),
    );
    const since = new Date(
      Math.max(oldest - 2 * DAY, Date.now() - 365 * DAY),
    ).toISOString();
    const idx = await this.branches
      .index(req.api, repo, req.ui.deployBranch, since)
      .catch(() => undefined);
    return {
      idx,
      histories: merged.length ? await this.histories(req, repo, aws) : [],
    };
  }

  private async histories(
    req: DeployRequest,
    repo: string,
    aws: AwsStatus,
  ): Promise<PipelineHistory[]> {
    if (!req.aws || aws.state !== "ok") return [];
    const cfg = req.aws;
    try {
      const names = await this.reader.pipelines(cfg, req.pipelinePrefix(repo));
      return await mapLimit(names, 3, (n) =>
        this.reader.history(cfg, n, req.ignoreStages),
      );
    } catch (e) {
      Object.assign(
        aws,
        e instanceof AwsError
          ? { state: e.kind, message: e.message }
          : { state: "error", message: (e as Error).message },
      );
      return [];
    }
  }

  private async toPr(
    req: DeployRequest,
    r: DeployRawPr,
    ctx: RepoContext,
  ): Promise<DeployPr> {
    const repo = r.repository.nameWithOwner;
    const ticket = ticketsOf(r, req.ticketPattern)[0];
    const base: DeployPr = {
      id: r.id,
      repo,
      number: r.number,
      title: r.title,
      url: r.url,
      author: r.author?.login ?? "ghost",
      mergedBy: r.mergedBy?.login,
      state: r.state,
      isDraft: r.isDraft,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      mergedAt: r.mergedAt ?? undefined,
      reviewDecision: r.reviewDecision ?? undefined,
      ticket,
      ticketUrl: ticketUrl(req.jiraBaseUrl, ticket),
      tracks: [],
    };
    const sha = r.mergeCommit?.oid;
    if (r.state !== "MERGED" || !sha) {
      // An open PR is "in the branch" only when its head commit already shows up in the branch history.
      return {
        ...base,
        inBranch: ctx.idx?.position.has(r.headRefOid) ? true : undefined,
      };
    }
    const contains = containsFn(this.branches, req.api, repo, ctx.idx);
    const inBranch = await contains(sha, req.ui.deployBranch).catch(
      () => undefined,
    );
    const tracks: PipelineTrack[] = [];
    for (const h of ctx.histories)
      tracks.push(await trackFor(h, sha, contains));
    // A monorepo has a pipeline per app: keep the ones that already picked this change up.
    const pickedUp = tracks.filter((t) =>
      t.stages.some((s) => s.state === "deployed"),
    );
    return {
      ...base,
      inBranch,
      revert: findRevert(ctx.idx, sha, r.number),
      tracks: pickedUp,
      pipelineCount: tracks.length,
    };
  }
}
