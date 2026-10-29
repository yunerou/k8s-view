import { HttpMethod, RequestContext, Watch } from "@kubernetes/client-node";
import { inject, injectable } from "@needle-di/core";
import { fetch } from "undici";
import { KubeApiError } from "../../app/ports/ClusterApi";
import type { KubeObject } from "../../core/resource/KubeResource";
import type { ResourceKind } from "../../core/resource/ResourceKind";
import { abortable, ExecCredentialProvider } from "./ExecCredentialProvider";
import { KubeClientFactory } from "./KubeClientFactory";
import { KubeTransport, type ListResult, type WatchEvent, type WatchHandle } from "./KubeTransport";

const PAGE_SIZE = 500;
const WATCH_TIMEOUT_SECONDS = 300;

/** Call the API server using client-node authentication (`RequestContext` + undici dispatcher), like the library's `Watch`. */
@injectable()
export class KubeHttp extends KubeTransport {
  constructor(
    private readonly clients = inject(KubeClientFactory),
    private readonly credentials = inject(ExecCredentialProvider),
  ) {
    super();
  }

  async getJson<T>(
    context: string,
    path: string,
    query: Record<string, string> = {},
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    const signals = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await this.send(context, path, query, "application/json", signals, signal, timeoutMs);
    const text = await response.text();
    if (!response.ok) throw this.statusError(context, response.status, response.statusText, text);
    return JSON.parse(text) as T;
  }

  async streamText(
    context: string,
    path: string,
    query: Record<string, string>,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.send(context, path, query, "*/*", signal, signal);
    if (!response.ok) throw this.statusError(context, response.status, response.statusText, await response.text());
    if (!response.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        if (text) onChunk(text);
      }
      const rest = decoder.decode();
      if (rest) onChunk(rest);
    } catch (e) {
      // Explicit cancellation (terminal closed, pod deleted): finish normally.
      if (signal.aborted) return;
      // client-node's dispatcher has a 300 s bodyTimeout: long-silent containers are not errors; callers reconnect.
      if (isBodyTimeout(e)) return;
      throw new KubeApiError((e as Error).message, undefined);
    }
  }

  async mutate(
    context: string,
    path: string,
    method: "PATCH" | "DELETE" | "POST",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const signals = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await this.send(context, path, {}, "application/json", signals, signal, 30_000, {
      method,
      body: JSON.stringify(body),
      contentType: method === "PATCH" ? "application/merge-patch+json" : "application/json",
    });
    const text = await response.text();
    if (!response.ok) throw this.statusError(context, response.status, response.statusText, text);
  }

  /** Authenticated GET request (exec plugin, client certificate, token) to the context's API server. */
  private async send(
    context: string,
    path: string,
    query: Record<string, string>,
    accept: string,
    fetchSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    timeoutMs?: number,
    mutation?: { method: "PATCH" | "DELETE" | "POST"; body: string; contentType: string },
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    const kc = this.clients.config(context);
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new KubeApiError(`Context '${context}' has no cluster`, undefined);
    const url = new URL(cluster.server.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const ctx = new RequestContext(url.toString(), mutation ? HttpMethod[mutation.method] : HttpMethod.GET);
    try {
      const auth = kc.applySecurityAuthentication(ctx);
      await (callerSignal ? abortable(auth, callerSignal) : auth);
    } catch (e) {
      throw callerSignal?.aborted ? e : authError(e);
    }
    try {
      const headers = ctx.getHeaders() as unknown as Record<string, string>;
      return await fetch(url, {
        method: mutation?.method ?? "GET",
        headers: { ...headers, Accept: accept, ...(mutation ? { "Content-Type": mutation.contentType } : {}) },
        ...(mutation ? { body: mutation.body } : {}),
        dispatcher: ctx.getDispatcher() as never,
        signal: fetchSignal,
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      if (err.name === "TimeoutError" && timeoutMs !== undefined)
        throw new KubeApiError(`Timed out after ${timeoutMs / 1000}s connecting to ${cluster.server}`, undefined);
      // Stream aborted before a response: let the caller receive AbortError as when reading the body.
      if (timeoutMs === undefined && callerSignal?.aborted) throw err;
      throw new KubeApiError(err.cause?.message ?? err.message, undefined, err.cause?.code);
    }
  }

  private statusError(context: string, status: number, statusText: string, body: string): KubeApiError {
    let message = `${status} ${statusText}`;
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(body) as { message?: string; reason?: string };
      message = parsed.message ?? message;
      reason = parsed.reason;
    } catch {
      // Body is not a Status object.
      if (body.trim()) message = body.trim();
    }
    // Exec plugin token revoked/expired early: rerun the plugin next time.
    if (status === 401) this.credentials.invalidate(context);
    return new KubeApiError(message, status, reason);
  }

  async list(
    context: string,
    kind: ResourceKind,
    namespace: string | undefined,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<ListResult> {
    const items: KubeObject[] = [];
    let token: string | undefined;
    let resourceVersion = "";
    do {
      const query: Record<string, string> = { ...extra, limit: String(PAGE_SIZE) };
      if (token) query["continue"] = token;
      const page = await this.getJson<{
        items?: KubeObject[];
        metadata?: { continue?: string; resourceVersion?: string };
      }>(context, kind.listPath(namespace), query, 60_000);
      items.push(...(page.items ?? []));
      token = page.metadata?.continue || undefined;
      resourceVersion = page.metadata?.resourceVersion ?? resourceVersion;
    } while (token);
    return { items, resourceVersion };
  }

  async watch(
    context: string,
    kind: ResourceKind,
    namespace: string | undefined,
    resourceVersion: string,
    onEvent: (e: WatchEvent) => void,
    onDone: (err: unknown) => void,
  ): Promise<WatchHandle> {
    const watch = new Watch(this.clients.config(context));
    const controller = await watch.watch(
      kind.listPath(namespace),
      { resourceVersion, allowWatchBookmarks: true, timeoutSeconds: WATCH_TIMEOUT_SECONDS },
      (type, object) => onEvent({ type: type as WatchEvent["type"], object }),
      (err) => {
        // No data before timeout: treat as a normal server close and resume watching.
        if (err && (err as Error).name === "TimeoutError") onDone(undefined);
        else if (err && (err as Error).name === "AbortError") onDone(undefined);
        else onDone(err ?? undefined);
      },
    );
    return { abort: () => controller.abort() };
  }
}

/** Exec auth plugin missing from PATH: identify the binary and explain the fix. */
function authError(e: unknown): Error {
  if (e instanceof KubeApiError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err.code === "ENOENT" && err.path) {
    return new KubeApiError(
      `Auth plugin '${err.path}' was not found in PATH. Add its folder to the 'k8sView.extraPath' setting.`,
      undefined,
      "ENOENT",
    );
  }
  return new KubeApiError(`Authentication failed: ${err.message}`, 401);
}

function isBodyTimeout(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | undefined;
  return err?.code === "UND_ERR_BODY_TIMEOUT" || err?.cause?.code === "UND_ERR_BODY_TIMEOUT";
}
