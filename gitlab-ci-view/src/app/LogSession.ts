import type { Job } from "../core/gitlab/model";
import { isActive } from "../core/gitlab/status";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { errorMessage } from "../core/util/errors";
import { type PipelineService, project } from "./PipelineService";
import { type GitLabApi, GitLabError, type GitLabErrorKind } from "./ports/GitLabApi";
import type { RepoRef } from "./RepoRegistry";

const POLL_MS = 3000;
/** Errors that cannot resolve on retry: stop polling. */
const FATAL = new Set<GitLabErrorKind>(["noToken", "unauthorized", "forbidden", "notFound"]);

/** Read a job trace: fetch new bytes by offset every `pollMs` until the job finishes. */
export class LogSession implements Disposable {
  private offset = 0;
  private readonly decoder = new TextDecoder();
  private text = "";
  private current: Job | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private paused = false;
  private polling = false;
  private finished = false;
  private lastError: string | undefined;
  private readonly appended = new Emitter<{ start: number; text: string }>();
  readonly onAppend = this.appended.event;
  private readonly statusChanged = new Emitter<Job>();
  readonly onStatus = this.statusChanged.event;
  private readonly failed = new Emitter<string>();
  readonly onError = this.failed.event;

  constructor(
    private readonly api: GitLabApi,
    private readonly pipelines: PipelineService,
    readonly repo: RepoRef,
    readonly jobId: number,
    private readonly pollMs = POLL_MS,
  ) {}

  get content(): string {
    return this.text;
  }

  get job(): Job | undefined {
    return this.current;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    clearTimeout(this.timer);
    if (!paused) void this.poll();
  }

  start(): Promise<void> {
    return this.poll();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.appended.dispose();
    this.statusChanged.dispose();
    this.failed.dispose();
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.paused || this.polling || this.finished) return;
    this.polling = true;
    let again: boolean;
    try {
      // Status first, trace second: if the job ends between calls, the next read still fetches the remaining tail.
      const job = await this.pipelines.getJob(this.repo, this.jobId);
      if (this.disposed) return;
      const changed = job.status !== this.current?.status;
      this.current = job;
      if (changed) this.statusChanged.fire(job);
      const active = isActive(job.status);
      const bytes = await this.api.getBytes(this.repo, `${project(this.repo)}/jobs/${this.jobId}/trace`, this.offset);
      if (this.disposed) return;
      if (this.lastError !== undefined) {
        this.lastError = undefined;
        this.failed.fire("");
      }
      this.offset += bytes.length;
      // Stream: retain partial UTF-8 characters for the next chunk.
      const chunk = this.decoder.decode(bytes, { stream: active });
      if (chunk) {
        const start = this.text.length;
        this.text += chunk;
        this.appended.fire({ start, text: chunk });
      }
      again = active;
      this.finished = !active;
    } catch (e) {
      if (this.disposed) return;
      this.lastError = errorMessage(e);
      this.failed.fire(this.lastError);
      again = !(e instanceof GitLabError && FATAL.has(e.kind));
      this.finished = !again;
    } finally {
      this.polling = false;
    }
    if (again && !this.disposed && !this.paused) this.timer = setTimeout(() => void this.poll(), this.pollMs);
  }
}
