import { inject, injectable } from "@needle-di/core";
import { jobActions, pipelineActions } from "../core/gitlab/actions";
import type { Job, Pipeline } from "../core/gitlab/model";
import { groupByStage } from "../core/gitlab/stages";
import { isActive } from "../core/gitlab/status";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { errorMessage } from "../core/util/errors";
import type {
  DetailTab,
  FullViewState,
  JobRow,
  PipelineDetail,
  PipelineRow,
  RepoInfo,
  RepoSection,
} from "../shared/protocol";
import { type DagResult, DagService } from "./DagService";
import { effectiveFilters } from "./filters";
import { PipelineService } from "./PipelineService";
import type { PollClient } from "./Poller";
import { type RepoRef, RepoRegistry } from "./RepoRegistry";
import { RepoSelection } from "./RepoSelection";
import { TokenStore } from "./TokenStore";

interface SectionData {
  readonly page: number;
  readonly pipelines: readonly Pipeline[];
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

interface DetailData {
  readonly repoId: string;
  readonly pipelineId: number;
  readonly pipeline?: Pipeline;
  readonly jobs: readonly Job[];
  readonly dag?: DagResult;
  readonly loading: boolean;
  readonly error?: string;
}

const pipelineRow = (p: Pipeline): PipelineRow => ({
  id: p.id,
  iid: p.iid,
  status: p.status,
  ref: p.ref,
  sha: p.sha,
  source: p.source,
  ...(p.tag !== undefined ? { tag: p.tag } : {}),
  createdAt: p.createdAt,
  webUrl: p.webUrl,
  actions: pipelineActions(p.status),
});

const jobRow = (j: Job): JobRow => ({
  id: j.id,
  name: j.name,
  stage: j.stage,
  status: j.status,
  allowFailure: j.allowFailure,
  duration: j.duration,
  webUrl: j.webUrl,
  actions: jobActions(j.status),
});

/** Full view state (independent of vscode): pages per repository, open pipeline, Jobs/DAG tab. */
@injectable()
export class FullViewModel implements PollClient, Disposable {
  private readonly changed = new Emitter<FullViewState>();
  readonly onDidChange = this.changed.event;
  private readonly sections = new Map<string, SectionData>();
  /** Latest load for each repository / detail pane: responses from older loads are discarded. */
  private readonly sectionSeq = new Map<string, number>();
  private seq = 0;
  private detailSeq = 0;
  private detail: DetailData | undefined;
  private tab: DetailTab = "jobs";
  private shown = false;
  private readonly subs: Disposable[];

  constructor(
    private readonly repos = inject(RepoRegistry),
    private readonly selection = inject(RepoSelection),
    private readonly tokens = inject(TokenStore),
    private readonly pipelines = inject(PipelineService),
    private readonly dags = inject(DagService),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.subs = [
      selection.onDidChange(() => {
        this.sectionSeq.clear();
        this.detailSeq++;
        this.sections.clear();
        if (this.shown) void this.reloadAll();
        else this.emit();
      }),
      tokens.onDidChange(() => {
        this.sectionSeq.clear();
        this.detailSeq++;
        this.sections.clear();
        if (this.shown) void this.reloadAll();
        else this.emit();
      }),
    ];
  }

  visible(): boolean {
    return this.shown;
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
  }

  state(): FullViewState {
    return {
      repos: this.repos.repos().map(
        (r): RepoInfo => ({
          id: r.id,
          name: r.name,
          host: r.host,
          projectPath: r.projectPath,
          branch: r.branch,
          token: this.tokenState(r.host),
        }),
      ),
      selection: this.selection.selection,
      filters: this.selection.filters,
      sections: this.selection.visibleRepos().map((r) => this.sectionState(r)),
      ...(this.detail ? { detail: this.detailState(this.detail) } : {}),
      now: this.now(),
    };
  }

  async setPage(repoId: string, page: number): Promise<void> {
    const repo = this.repos.get(repoId);
    if (repo && Number.isFinite(page)) await this.loadSection(repo, Math.max(1, Math.floor(page)));
  }

  async open(repoId: string, pipelineId: number): Promise<void> {
    this.detail = { repoId, pipelineId, jobs: [], loading: true };
    this.tab = "jobs";
    this.emit();
    await this.loadDetail();
  }

  close(): void {
    this.detail = undefined;
    this.detailSeq++;
    this.emit();
  }

  async setTab(tab: DetailTab): Promise<void> {
    this.tab = tab;
    this.emit();
    if (tab === "dag" && this.detail && !this.detail.dag) await this.loadDetail();
  }

  async refresh(): Promise<boolean> {
    await this.reloadAll();
    return (
      [...this.sections.values()].some((s) => s.pipelines.some((p) => isActive(p.status))) ||
      (this.detail?.jobs.some((j) => isActive(j.status)) ?? false)
    );
  }

  /** Jobs in the open pipeline (to include the job name when playing a job). */
  job(repoId: string, jobId: number): Job | undefined {
    return this.detail?.repoId === repoId ? this.detail.jobs.find((j) => j.id === jobId) : undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }

  private emit(): void {
    this.changed.fire(this.state());
  }

  private tokenState(host: string): RepoInfo["token"] {
    const meta = this.tokens.meta(host);
    return !meta ? "missing" : meta.invalid ? "invalid" : "ok";
  }

  private sectionState(repo: RepoRef): RepoSection {
    const s = this.sections.get(repo.id);
    return {
      repoId: repo.id,
      page: s?.page ?? 1,
      hasNext: s?.hasNext ?? false,
      loading: s?.loading ?? false,
      rows: (s?.pipelines ?? []).map(pipelineRow),
      ...(s?.error ? { error: s.error } : {}),
    };
  }

  private detailState(d: DetailData): PipelineDetail {
    return {
      repoId: d.repoId,
      pipelineId: d.pipelineId,
      pipeline: d.pipeline ? pipelineRow(d.pipeline) : undefined,
      tab: this.tab,
      stages: groupByStage(d.jobs).map((g) => ({ stage: g.stage, jobs: g.jobs.map(jobRow) })),
      ...(d.dag
        ? { dag: { layout: d.dag.layout, fallback: d.dag.fallback, ...(d.dag.error ? { error: d.dag.error } : {}) } }
        : {}),
      loading: d.loading,
      ...(d.error ? { error: d.error } : {}),
    };
  }

  private async reloadAll(): Promise<void> {
    await Promise.all([
      ...this.selection.visibleRepos().map((r) => this.loadSection(r, this.sections.get(r.id)?.page ?? 1)),
      this.loadDetail(),
    ]);
  }

  private async loadSection(repo: RepoRef, page: number): Promise<void> {
    if (this.tokenState(repo.host) !== "ok") {
      this.sections.delete(repo.id);
      this.emit();
      return;
    }
    const seq = ++this.seq;
    this.sectionSeq.set(repo.id, seq);
    const prev = this.sections.get(repo.id);
    const kept = prev?.page === page ? prev.pipelines : [];
    this.sections.set(repo.id, { page, pipelines: kept, hasNext: prev?.hasNext ?? false, loading: true });
    this.emit();
    let next: SectionData;
    try {
      const filters = effectiveFilters(repo, this.selection.filters, this.tokens.meta(repo.host)?.username);
      const r = await this.pipelines.listPipelines(repo, page, filters);
      next = { page, pipelines: r.items, hasNext: r.nextPage !== undefined, loading: false };
    } catch (e) {
      next = { page, pipelines: kept, hasNext: prev?.hasNext ?? false, loading: false, error: errorMessage(e) };
    }
    if (this.sectionSeq.get(repo.id) !== seq) return;
    this.sections.set(repo.id, next);
    this.emit();
  }

  private async loadDetail(): Promise<void> {
    const d = this.detail;
    if (!d) return;
    const repo = this.repos.get(d.repoId);
    if (!repo || this.tokenState(repo.host) !== "ok") {
      this.close();
      return;
    }
    const seq = ++this.detailSeq;
    const tab = this.tab;
    let next: DetailData;
    try {
      const [pipeline, jobs] = await Promise.all([
        this.pipelines.getPipeline(repo, d.pipelineId),
        this.pipelines.listJobs(repo, d.pipelineId),
      ]);
      const dag = tab === "dag" ? await this.dags.load(repo, pipeline, jobs) : d.dag;
      next = { repoId: d.repoId, pipelineId: d.pipelineId, pipeline, jobs, loading: false, ...(dag ? { dag } : {}) };
    } catch (e) {
      next = { ...d, loading: false, error: errorMessage(e) };
    }
    if (seq !== this.detailSeq) return;
    this.detail = next;
    this.emit();
  }
}
