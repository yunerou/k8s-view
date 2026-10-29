import { inject, injectable } from "@needle-di/core";
import { z } from "zod";
import {
  type CiVariable,
  type Job,
  jobSchema,
  type Pipeline,
  type PipelineFilters,
  pipelineSchema,
} from "../core/gitlab/model";
import { type ApiResult, GitLabApi } from "./ports/GitLabApi";
import type { RepoRef } from "./RepoRegistry";

export const PAGE_SIZE = 20;
const JOBS_PER_PAGE = 100;
/** Safety limit: 1000 jobs per pipeline. */
const MAX_JOB_PAGES = 10;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextPage: number | undefined;
}

export function project(repo: { readonly projectPath: string }): string {
  return `/projects/${encodeURIComponent(repo.projectPath)}`;
}

const branchesSchema = z.array(z.object({ name: z.string() }));

@injectable()
export class PipelineService {
  /** Source/tag do not change with status; cache them to avoid 20 extra requests per poll. */
  private readonly metadata = new Map<string, Promise<Pick<Pipeline, "source" | "tag">>>();
  constructor(private readonly api = inject(GitLabApi)) {}

  async listPipelines(
    repo: RepoRef,
    page: number,
    filters: PipelineFilters,
    perPage = PAGE_SIZE,
  ): Promise<Page<Pipeline>> {
    const r = await this.api.get(
      repo,
      `${project(repo)}/pipelines`,
      { page, per_page: perPage, order_by: "id", sort: "desc", ...filters },
      z.array(pipelineSchema),
    );
    const items = [...r.data];
    // The list API usually omits `tag`; fetch metadata with at most 4 concurrent requests.
    if (perPage > 1) {
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, items.length) }, async () => {
          while (index < items.length) {
            const i = index++;
            const pipeline = items[i]!;
            if (pipeline.tag !== undefined && pipeline.source !== undefined) continue;
            try {
              const metadata = await this.pipelineMetadata(repo, pipeline.id);
              items[i] = { ...pipeline, ...metadata, source: metadata.source ?? pipeline.source };
            } catch {
              // Still display the list if the detail endpoint is restricted or temporarily unavailable.
            }
          }
        }),
      );
    }
    return { items, nextPage: r.nextPage };
  }

  private pipelineMetadata(repo: RepoRef, id: number): Promise<Pick<Pipeline, "source" | "tag">> {
    const key = JSON.stringify([repo.apiUrl, repo.projectPath, id]);
    const cached = this.metadata.get(key);
    if (cached) return cached;
    const loading = this.getPipeline(repo, id)
      .then((pipeline) => ({ source: pipeline.source, ...(pipeline.tag !== undefined ? { tag: pipeline.tag } : {}) }))
      .catch((error: unknown) => {
        this.metadata.delete(key);
        throw error;
      });
    if (this.metadata.size >= 1000) this.metadata.delete(this.metadata.keys().next().value!);
    this.metadata.set(key, loading);
    return loading;
  }

  async getPipeline(repo: RepoRef, id: number): Promise<Pipeline> {
    return (await this.api.get(repo, `${project(repo)}/pipelines/${id}`, {}, pipelineSchema)).data;
  }

  /** All jobs (latest attempts) in the pipeline, ordered by ascending ID. */
  async listJobs(repo: RepoRef, pipelineId: number): Promise<Job[]> {
    const jobs: Job[] = [];
    let page: number | undefined = 1;
    for (let i = 0; page !== undefined && i < MAX_JOB_PAGES; i++) {
      const r: ApiResult<Job[]> = await this.api.get(
        repo,
        `${project(repo)}/pipelines/${pipelineId}/jobs`,
        { page, per_page: JOBS_PER_PAGE },
        z.array(jobSchema),
      );
      jobs.push(...r.data);
      page = r.nextPage;
    }
    return jobs.sort((a, b) => a.id - b.id);
  }

  async getJob(repo: RepoRef, jobId: number): Promise<Job> {
    return (await this.api.get(repo, `${project(repo)}/jobs/${jobId}`, {}, jobSchema)).data;
  }

  retryPipeline(repo: RepoRef, id: number): Promise<Pipeline> {
    return this.api.post(repo, `${project(repo)}/pipelines/${id}/retry`, {}, pipelineSchema);
  }

  cancelPipeline(repo: RepoRef, id: number): Promise<Pipeline> {
    return this.api.post(repo, `${project(repo)}/pipelines/${id}/cancel`, {}, pipelineSchema);
  }

  /** Return the new job created by GitLab for the retry. */
  retryJob(repo: RepoRef, jobId: number): Promise<Job> {
    return this.api.post(repo, `${project(repo)}/jobs/${jobId}/retry`, {}, jobSchema);
  }

  cancelJob(repo: RepoRef, jobId: number): Promise<Job> {
    return this.api.post(repo, `${project(repo)}/jobs/${jobId}/cancel`, {}, jobSchema);
  }

  playJob(repo: RepoRef, jobId: number, variables: readonly CiVariable[] = []): Promise<Job> {
    const body =
      variables.length > 0 ? { job_variables_attributes: variables.map((v) => ({ key: v.key, value: v.value })) } : {};
    return this.api.post(repo, `${project(repo)}/jobs/${jobId}/play`, body, jobSchema);
  }

  createPipeline(repo: RepoRef, ref: string, variables: readonly CiVariable[]): Promise<Pipeline> {
    return this.api.post(
      repo,
      `${project(repo)}/pipeline`,
      { ref, variables: variables.map((v) => ({ key: v.key, value: v.value, variable_type: "env_var" })) },
      pipelineSchema,
    );
  }

  async listBranches(repo: RepoRef): Promise<string[]> {
    const r = await this.api.get(repo, `${project(repo)}/repository/branches`, { per_page: 100 }, branchesSchema);
    return r.data.map((b) => b.name);
  }
}
