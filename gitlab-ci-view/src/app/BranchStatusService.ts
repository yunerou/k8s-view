import { inject, injectable } from "@needle-di/core";
import type { Pipeline } from "../core/gitlab/model";
import { isActive } from "../core/gitlab/status";
import { finishedOutcome, type PipelineOutcome, shouldNotify } from "../core/notify/transitions";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { PipelineService } from "./PipelineService";
import type { PollClient } from "./Poller";
import { Notifier } from "./ports/Notifier";
import { Settings } from "./ports/Settings";
import { type RepoRef, RepoRegistry } from "./RepoRegistry";
import { TokenStore } from "./TokenStore";

/** Latest pipeline on each repository's checked-out branch: source for the status bar and notifications. */
@injectable()
export class BranchStatusService implements PollClient, Disposable {
  private readonly latest = new Map<string, { readonly branch: string; readonly pipeline: Pipeline | undefined }>();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly openRequested = new Emitter<{ readonly repoId: string; readonly pipelineId: number }>();
  /** The user clicked "Open" in a notification. */
  readonly onOpenRequested = this.openRequested.event;

  constructor(
    private readonly repos = inject(RepoRegistry),
    private readonly tokens = inject(TokenStore),
    private readonly pipelines = inject(PipelineService),
    private readonly settings = inject(Settings),
    private readonly notifier = inject(Notifier),
  ) {}

  /** The status bar is always visible, so always poll. */
  visible(): boolean {
    return true;
  }

  latestFor(repoId: string): Pipeline | undefined {
    const latest = this.latest.get(repoId);
    return latest?.branch === this.repos.get(repoId)?.branch ? latest?.pipeline : undefined;
  }

  async refresh(): Promise<boolean> {
    for (const id of this.latest.keys()) if (!this.repos.get(id)) this.latest.delete(id);
    const active = await Promise.all(this.repos.repos().map((repo) => this.refreshRepo(repo)));
    this.changed.fire();
    return active.some(Boolean);
  }

  dispose(): void {
    this.changed.dispose();
    this.openRequested.dispose();
  }

  private async refreshRepo(repo: RepoRef): Promise<boolean> {
    const meta = this.tokens.meta(repo.host);
    const branch = repo.branch;
    if (!branch || !meta || meta.invalid) {
      this.latest.delete(repo.id);
      return false;
    }
    let next: Pipeline | undefined;
    try {
      next = (await this.pipelines.listPipelines(repo, 1, { ref: branch }, 1)).items[0];
    } catch {
      // Keep the previous state; the tree/Full view already shows the error.
      return false;
    }
    // Discard the response if the repository/branch changed while waiting for the network.
    const current = this.repos.get(repo.id);
    if (current?.branch !== branch || current.apiUrl !== repo.apiUrl || current.projectPath !== repo.projectPath)
      return false;
    const prev = this.latest.get(repo.id);
    // Branch just changed: do not compare with the previous branch's pipeline.
    const outcome = prev?.branch === branch ? finishedOutcome(prev.pipeline, next) : undefined;
    this.latest.set(repo.id, { branch, pipeline: next });
    if (outcome && next && shouldNotify(outcome, this.settings.notifications())) void this.notify(repo, next, outcome);
    return next !== undefined && isActive(next.status);
  }

  private async notify(repo: RepoRef, p: Pipeline, outcome: PipelineOutcome): Promise<void> {
    const text = `${repo.name}: pipeline #${p.id} on ${p.ref} ${outcome}.`;
    const action =
      outcome === "failed" ? await this.notifier.error(text, "Open") : await this.notifier.info(text, "Open");
    if (action === "Open") this.openRequested.fire({ repoId: repo.id, pipelineId: p.id });
  }
}
