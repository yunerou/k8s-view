import type { z } from "zod";
import type { HostTarget } from "../../core/remote/remote";
import type { Event } from "../../core/util/Emitter";

export type GitLabErrorKind =
  | "noToken"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "tls"
  | "network"
  | "timeout"
  | "http"
  | "invalidResponse";

export class GitLabError extends Error {
  constructor(
    readonly kind: GitLabErrorKind,
    message: string,
    readonly host: string,
    readonly status?: number | undefined,
  ) {
    super(message);
    this.name = "GitLabError";
  }
}

export interface RequestOptions {
  /** Use this token instead of the stored token (to validate a newly entered token). */
  readonly token?: string;
}

export interface ApiResult<T> {
  readonly data: T;
  /** From the `x-next-page` header; `undefined` = last page. */
  readonly nextPage: number | undefined;
}

export type Query = Readonly<Record<string, string | number | undefined>>;

/** Port: REST v4 + GraphQL for a GitLab instance. `path` is relative to `/api/v4`. */
export abstract class GitLabApi {
  /** Host that just returned 401 for the stored token. */
  abstract readonly onUnauthorized: Event<string>;
  abstract get<T>(
    target: HostTarget,
    path: string,
    query: Query,
    schema: z.ZodType<T>,
    options?: RequestOptions,
  ): Promise<ApiResult<T>>;
  abstract post<T>(target: HostTarget, path: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
  /** Content starting at byte `offset` (job trace). */
  abstract getBytes(target: HostTarget, path: string, offset: number): Promise<Uint8Array>;
  abstract graphql<T>(
    target: HostTarget,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ): Promise<T>;
}
