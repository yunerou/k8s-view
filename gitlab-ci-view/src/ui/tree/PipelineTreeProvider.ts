import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { effectiveFilters } from "../../app/filters";
import { PipelineService } from "../../app/PipelineService";
import { type PollClient, Poller } from "../../app/Poller";
import { type RepoRef, RepoRegistry } from "../../app/RepoRegistry";
import { RepoSelection } from "../../app/RepoSelection";
import { TokenStore } from "../../app/TokenStore";
import { jobActions, pipelineActions } from "../../core/gitlab/actions";
import { pipelineEvent } from "../../core/gitlab/filterOptions";
import type { Job, Pipeline, PipelineFilters } from "../../core/gitlab/model";
import { groupByStage, stageStatus } from "../../core/gitlab/stages";
import { isActive, statusLabel } from "../../core/gitlab/status";
import type { Disposable } from "../../core/util/Emitter";
import { errorMessage } from "../../core/util/errors";
import { formatAge, formatDuration } from "../../core/util/format";
import { statusThemeIcon } from "../icons";
import { contextValue, type TreeNode } from "./TreeNode";

export const PIPELINES_VIEW_ID = "gitlabCiView.pipelines";

interface Listing {
  readonly pipelines: readonly Pipeline[];
  readonly nextPage: number | undefined;
  /** Number of loaded pages (refresh reloads this many pages). */
  readonly pages: number;
  readonly error?: string;
}

interface JobsEntry {
  readonly repoId: string;
  readonly pipelineId: number;
  readonly jobs: readonly Job[];
  readonly error?: string;
}

const jobsKey = (repoId: string, pipelineId: number) => `${repoId}#${pipelineId}`;

function dedupe(pipelines: readonly Pipeline[]): Pipeline[] {
  const seen = new Set<number>();
  return pipelines.filter((p) => !seen.has(p.id) && seen.add(p.id));
}

/** Compact view: (Repo →) Pipeline → Stage → Job; each repository paginates independently using a "Load more…" node. */
@injectable()
export class PipelineTreeProvider implements vscode.TreeDataProvider<TreeNode>, PollClient, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly listings = new Map<string, Listing>();
  /** Jobs in expanded pipelines. */
  private readonly jobs = new Map<string, JobsEntry>();
  /** Incremented on every reset: results from older loads are discarded. */
  private generation = 0;
  private shown = false;
  private readonly subs: Disposable[];

  constructor(
    private readonly repos = inject(RepoRegistry),
    private readonly selection = inject(RepoSelection),
    private readonly pipelines = inject(PipelineService),
    private readonly tokens = inject(TokenStore),
    private readonly poller = inject(Poller),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.subs = [
      selection.onDidChange(() => this.reset()),
      tokens.onDidChange(() => this.reset()),
      poller.register(this),
    ];
  }

  visible(): boolean {
    return this.shown;
  }

  setVisible(visible: boolean): void {
    const appeared = visible && !this.shown;
    this.shown = visible;
    if (appeared) this.poller.now();
  }

  setExpanded(node: TreeNode, expanded: boolean): void {
    if (node.type === "pipeline" && !expanded) this.jobs.delete(jobsKey(node.repo.id, node.pipeline.id));
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const repos = this.selection.visibleRepos();
      return repos.length === 1 ? this.repoChildren(repos[0]!) : repos.map((repo) => ({ type: "repo", repo }));
    }
    switch (node.type) {
      case "repo":
        return this.repoChildren(node.repo);
      case "pipeline":
        return this.pipelineChildren(node.repo, node.pipeline);
      case "stage":
        return node.jobs.map((job) => ({ type: "job", repo: node.repo, pipeline: node.pipeline, job }));
      default:
        return [];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const { None, Collapsed, Expanded } = vscode.TreeItemCollapsibleState;
    switch (node.type) {
      case "repo": {
        const item = new vscode.TreeItem(node.repo.name, Expanded);
        item.id = `repo:${node.repo.id}`;
        item.description = node.repo.branch ? `${node.repo.projectPath} · ${node.repo.branch}` : node.repo.projectPath;
        item.tooltip = `${node.repo.apiUrl}/${node.repo.projectPath}`;
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "repo";
        return item;
      }
      case "pipeline": {
        const p = node.pipeline;
        const item = new vscode.TreeItem(`#${p.id} ${p.ref}`, Collapsed);
        item.id = `pipeline:${node.repo.id}#${p.id}`;
        item.description = `${statusLabel(p.status)} · ${pipelineEvent(p)} · ${formatAge(p.createdAt, this.now())}`;
        item.tooltip = new vscode.MarkdownString(
          `**Pipeline #${p.id}** (${statusLabel(p.status)})\n\nRef \`${p.ref}\` · \`${p.sha.slice(0, 8)}\`\n\nEvent: ${pipelineEvent(p)} · created ${p.createdAt}`,
        );
        item.iconPath = statusThemeIcon(p.status);
        item.contextValue = contextValue("pipeline", pipelineActions(p.status));
        return item;
      }
      case "stage": {
        const status = stageStatus(node.jobs);
        const item = new vscode.TreeItem(
          node.stage,
          status === "success" || status === "skipped" ? Collapsed : Expanded,
        );
        item.id = `stage:${node.repo.id}#${node.pipeline.id}:${node.stage}`;
        item.description = `${node.jobs.length} job${node.jobs.length === 1 ? "" : "s"}`;
        item.iconPath = statusThemeIcon(status);
        item.contextValue = "stage";
        return item;
      }
      case "job": {
        const j = node.job;
        const item = new vscode.TreeItem(j.name, None);
        item.id = `job:${node.repo.id}#${j.id}`;
        const duration = formatDuration(j.duration);
        item.description = duration ? `${statusLabel(j.status)} · ${duration}` : statusLabel(j.status);
        item.tooltip = `${j.name} (${statusLabel(j.status)}${j.allowFailure ? ", allowed to fail" : ""})`;
        item.iconPath = statusThemeIcon(j.status, j.allowFailure);
        item.contextValue = contextValue("job", jobActions(j.status));
        item.command = { command: "gitlabCiView.openLog", title: "Open job log", arguments: [node] };
        return item;
      }
      case "loadMore": {
        const item = new vscode.TreeItem("Load more…", None);
        item.id = `more:${node.repo.id}`;
        item.iconPath = new vscode.ThemeIcon("ellipsis");
        item.command = { command: "gitlabCiView.loadMore", title: "Load more pipelines", arguments: [node] };
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.text, None);
        item.id = node.key;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.tooltip) item.tooltip = node.tooltip;
        if (node.command) item.command = { ...node.command, arguments: [...(node.command.arguments ?? [])] };
        return item;
      }
    }
  }

  async loadMore(repo: RepoRef): Promise<void> {
    const listing = this.listings.get(repo.id);
    if (!listing || listing.nextPage === undefined) return;
    const generation = this.generation;
    let next: Listing;
    try {
      const page = await this.pipelines.listPipelines(repo, listing.nextPage, this.filters(repo));
      next = {
        pipelines: dedupe([...listing.pipelines, ...page.items]),
        nextPage: page.nextPage,
        pages: listing.pages + 1,
      };
    } catch (e) {
      next = { ...listing, error: errorMessage(e) };
    }
    if (generation !== this.generation) return;
    this.listings.set(repo.id, next);
    this.changed.fire(undefined);
  }

  async refresh(): Promise<boolean> {
    const generation = this.generation;
    const listings = await Promise.all(
      this.selection.visibleRepos().map(async (repo) => {
        const prev = this.listings.get(repo.id);
        return prev && this.hasToken(repo) ? ([repo.id, await this.fetch(repo, prev.pages, prev)] as const) : undefined;
      }),
    );
    const jobs = await Promise.all(
      [...this.jobs.values()].map(async (entry) => {
        const repo = this.repos.get(entry.repoId);
        return repo ? await this.fetchJobs(repo, entry.pipelineId, entry) : undefined;
      }),
    );
    if (generation !== this.generation) return false;
    for (const l of listings) if (l) this.listings.set(l[0], l[1]);
    for (const entry of jobs) {
      const key = entry && jobsKey(entry.repoId, entry.pipelineId);
      // Pipeline collapsed while loading: do not add it back.
      if (entry && key && this.jobs.has(key)) this.jobs.set(key, entry);
    }
    this.changed.fire(undefined);
    return (
      [...this.listings.values()].some((l) => l.pipelines.some((p) => isActive(p.status))) ||
      [...this.jobs.values()].some((e) => e.jobs.some((j) => isActive(j.status)))
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }

  private reset(): void {
    this.generation++;
    this.listings.clear();
    this.jobs.clear();
    this.changed.fire(undefined);
  }

  private hasToken(repo: RepoRef): boolean {
    const meta = this.tokens.meta(repo.host);
    return meta !== undefined && !meta.invalid;
  }

  private filters(repo: RepoRef): PipelineFilters {
    return effectiveFilters(repo, this.selection.filters, this.tokens.meta(repo.host)?.username);
  }

  private async repoChildren(repo: RepoRef): Promise<TreeNode[]> {
    const meta = this.tokens.meta(repo.host);
    if (!meta || meta.invalid) {
      return [
        {
          type: "message",
          key: `token:${repo.id}`,
          text: meta
            ? `Token for ${repo.host} was rejected. Click to update it.`
            : `Set a GitLab token for ${repo.host}`,
          icon: meta ? "warning" : "key",
          command: { command: "gitlabCiView.setToken", title: "Set GitLab token", arguments: [repo.host] },
        },
      ];
    }
    let listing = this.listings.get(repo.id);
    if (!listing) {
      const generation = this.generation;
      listing = await this.fetch(repo, 1, undefined);
      if (generation === this.generation) this.listings.set(repo.id, listing);
    }
    const nodes: TreeNode[] = listing.pipelines.map((pipeline) => ({ type: "pipeline", repo, pipeline }));
    if (listing.error) nodes.push({ type: "message", key: `error:${repo.id}`, text: listing.error, icon: "error" });
    else if (nodes.length === 0)
      nodes.push({ type: "message", key: `empty:${repo.id}`, text: "No pipelines match the filters", icon: "info" });
    if (listing.nextPage !== undefined) nodes.push({ type: "loadMore", repo });
    return nodes;
  }

  private async pipelineChildren(repo: RepoRef, pipeline: Pipeline): Promise<TreeNode[]> {
    const key = jobsKey(repo.id, pipeline.id);
    let entry = this.jobs.get(key);
    if (!entry) {
      entry = await this.fetchJobs(repo, pipeline.id, undefined);
      this.jobs.set(key, entry);
    }
    const nodes: TreeNode[] = groupByStage(entry.jobs).map((g) => ({
      type: "stage",
      repo,
      pipeline,
      stage: g.stage,
      jobs: g.jobs,
    }));
    if (entry.error) nodes.push({ type: "message", key: `jobs-error:${key}`, text: entry.error, icon: "error" });
    return nodes;
  }

  /** Reload the first `pages` pages; on error, keep old data with a message. */
  private async fetch(repo: RepoRef, pages: number, prev: Listing | undefined): Promise<Listing> {
    const filters = this.filters(repo);
    const pipelines: Pipeline[] = [];
    let nextPage: number | undefined = 1;
    let loaded = 0;
    try {
      while (nextPage !== undefined && loaded < Math.max(1, pages)) {
        const page = await this.pipelines.listPipelines(repo, nextPage, filters);
        pipelines.push(...page.items);
        nextPage = page.nextPage;
        loaded++;
      }
      return { pipelines: dedupe(pipelines), nextPage, pages: loaded };
    } catch (e) {
      return {
        pipelines: prev?.pipelines ?? [],
        nextPage: prev?.nextPage,
        pages: prev?.pages ?? 1,
        error: errorMessage(e),
      };
    }
  }

  private async fetchJobs(repo: RepoRef, pipelineId: number, prev: JobsEntry | undefined): Promise<JobsEntry> {
    try {
      return { repoId: repo.id, pipelineId, jobs: await this.pipelines.listJobs(repo, pipelineId) };
    } catch (e) {
      return { repoId: repo.id, pipelineId, jobs: prev?.jobs ?? [], error: errorMessage(e) };
    }
  }
}
