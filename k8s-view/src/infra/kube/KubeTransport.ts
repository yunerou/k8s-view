import type { KubeObject } from "../../core/resource/KubeResource";
import type { ResourceKind } from "../../core/resource/ResourceKind";

export interface ListResult {
  readonly items: KubeObject[];
  readonly resourceVersion: string;
}

export interface WatchEvent {
  readonly type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";
  readonly object: KubeObject & { code?: number; message?: string };
}

export interface WatchHandle {
  abort(): void;
}

/** Context-specific API server access (paginated list, watch, GET); replaced by fakes in tests. */
export abstract class KubeTransport {
  /** `query`: additional list parameters (e.g. `labelSelector`). */
  abstract list(
    context: string,
    kind: ResourceKind,
    namespace: string | undefined,
    query?: Readonly<Record<string, string>>,
  ): Promise<ListResult>;
  /** `onDone(undefined)` when the server closes normally; `onDone(err)` on errors (err.status if available). */
  abstract watch(
    context: string,
    kind: ResourceKind,
    namespace: string | undefined,
    resourceVersion: string,
    onEvent: (e: WatchEvent) => void,
    onDone: (err: unknown) => void,
  ): Promise<WatchHandle>;
  abstract getJson<T>(
    context: string,
    path: string,
    query?: Record<string, string>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  /** GET streaming text (logs): `onChunk` for each chunk; completes when the server closes or `signal` is aborted. */
  abstract streamText(
    context: string,
    path: string,
    query: Record<string, string>,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
