import type { z } from "zod";
import {
  type ApiResult,
  GitLabApi,
  GitLabError,
  type Query,
  type RequestOptions,
} from "../../../src/app/ports/GitLabApi";
import type { RepoRef } from "../../../src/app/RepoRegistry";
import { type Job, jobSchema, type Pipeline, pipelineSchema } from "../../../src/core/gitlab/model";
import type { HostTarget } from "../../../src/core/remote/remote";
import { Emitter } from "../../../src/core/util/Emitter";

export interface FakeCall {
  readonly method: "GET" | "POST" | "BYTES" | "GRAPHQL";
  readonly path: string;
  readonly query?: Query;
  readonly body?: unknown;
  readonly token?: string | undefined;
  readonly offset?: number;
  readonly variables?: Readonly<Record<string, unknown>>;
}

/** Route value containing `x-next-page`. */
export class Paged {
  constructor(
    readonly data: unknown,
    readonly next: number | undefined,
  ) {}
}

type Route = unknown;

/** Fake GitLabApi: routes keyed by `"GET /path"`, with raw GitLab JSON, Error, Promise, or a function receiving FakeCall as values. */
export class FakeGitLabApi extends GitLabApi {
  readonly unauthorized = new Emitter<string>();
  readonly onUnauthorized = this.unauthorized.event;
  readonly calls: FakeCall[] = [];
  private readonly routes = new Map<string, Route>();

  route(key: string, value: Route): this {
    this.routes.set(key, value);
    return this;
  }

  callsTo(method: FakeCall["method"], path: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async get<T>(
    _t: HostTarget,
    path: string,
    query: Query,
    schema: z.ZodType<T>,
    options?: RequestOptions,
  ): Promise<ApiResult<T>> {
    const v = await this.resolve({ method: "GET", path, query, token: options?.token });
    return v instanceof Paged
      ? { data: schema.parse(v.data), nextPage: v.next }
      : { data: schema.parse(v), nextPage: undefined };
  }

  async post<T>(_t: HostTarget, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(await this.resolve({ method: "POST", path, body }));
  }

  async getBytes(_t: HostTarget, path: string, offset: number): Promise<Uint8Array> {
    return (await this.resolve({ method: "BYTES", path, offset })) as Uint8Array;
  }

  async graphql<T>(
    _t: HostTarget,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return schema.parse(await this.resolve({ method: "GRAPHQL", path: "graphql", body: query, variables }));
  }

  /** Route values may be Promises: tests control response order. */
  private async resolve(call: FakeCall): Promise<unknown> {
    this.calls.push(call);
    const key = `${call.method} ${call.path}`;
    if (!this.routes.has(key)) throw new GitLabError("notFound", `No fake route for ${key}`, "test", 404);
    const route = this.routes.get(key);
    const value = await (typeof route === "function" ? (route as (c: FakeCall) => unknown)(call) : route);
    if (value instanceof Error) throw value;
    return value;
  }
}

export function rawPipeline(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (patch["id"] as number | undefined) ?? 1;
  return {
    id,
    iid: id,
    project_id: 7,
    status: "success",
    source: "push",
    tag: false,
    ref: "main",
    sha: "abc1234",
    web_url: `https://gitlab.com/team/web/-/pipelines/${id}`,
    created_at: "2026-10-29T10:00:00Z",
    updated_at: "2026-10-29T10:05:00Z",
    ...patch,
  };
}

export function rawJob(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (patch["id"] as number | undefined) ?? 100;
  return {
    id,
    name: "build",
    stage: "build",
    status: "success",
    allow_failure: false,
    duration: 12.5,
    web_url: `https://gitlab.com/team/web/-/jobs/${id}`,
    created_at: "2026-10-29T10:00:00Z",
    started_at: "2026-10-29T10:00:01Z",
    finished_at: "2026-10-29T10:00:14Z",
    pipeline: { id: 1 },
    ...patch,
  };
}

export const pipeline = (patch: Record<string, unknown> = {}): Pipeline => pipelineSchema.parse(rawPipeline(patch));
export const job = (patch: Record<string, unknown> = {}): Job => jobSchema.parse(rawJob(patch));

export function repoRef(patch: Partial<RepoRef> = {}): RepoRef {
  return {
    id: "file:///ws/web",
    name: "web",
    host: "gitlab.com",
    apiUrl: "https://gitlab.com",
    projectPath: "team/web",
    branch: "main",
    ...patch,
  };
}
