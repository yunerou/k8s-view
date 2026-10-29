import { z } from "zod";

/** Pipeline from REST `GET /projects/:id/pipelines`. Keep `status` as a string to accommodate new GitLab statuses. */
export const pipelineSchema = z
  .object({
    id: z.number(),
    iid: z.number(),
    project_id: z.number(),
    status: z.string(),
    source: z.string().nullish(),
    tag: z.boolean().optional(),
    ref: z.string(),
    sha: z.string(),
    web_url: z.string(),
    created_at: z.string(),
    updated_at: z.string().nullish(),
  })
  .transform((p) => ({
    id: p.id,
    iid: p.iid,
    projectId: p.project_id,
    status: p.status,
    source: p.source ?? undefined,
    ...(p.tag !== undefined ? { tag: p.tag } : {}),
    ref: p.ref,
    sha: p.sha,
    webUrl: p.web_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at ?? undefined,
  }));
export type Pipeline = z.output<typeof pipelineSchema>;

export const jobSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    stage: z.string(),
    status: z.string(),
    allow_failure: z.boolean().default(false),
    duration: z.number().nullish(),
    web_url: z.string(),
    created_at: z.string(),
    started_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    pipeline: z.object({ id: z.number() }).optional(),
  })
  .transform((j) => ({
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    allowFailure: j.allow_failure,
    duration: j.duration ?? undefined,
    webUrl: j.web_url,
    createdAt: j.created_at,
    startedAt: j.started_at ?? undefined,
    finishedAt: j.finished_at ?? undefined,
    pipelineId: j.pipeline?.id,
  }));
export type Job = z.output<typeof jobSchema>;

export interface CiVariable {
  readonly key: string;
  readonly value: string;
}

/** Filter parameters sent to `GET /projects/:id/pipelines`. */
export interface PipelineFilters {
  readonly ref?: string;
  readonly status?: string;
  readonly source?: string;
  readonly username?: string;
  readonly scope?: "tags";
}

export type RefFilterMode = "current" | "all" | "tags";

/** User-selected filters (persisted per workspace). Empty string = no filter. */
export interface FilterState {
  readonly ref: RefFilterMode;
  /** Exact branch/tag name; empty = no name filter. */
  readonly refName?: string;
  readonly status: string;
  readonly source: string;
  readonly mine: boolean;
}
