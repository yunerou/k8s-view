import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { rootCertificates } from "node:tls";
import { inject, injectable } from "@needle-di/core";
import { Agent, fetch } from "undici";
import { z } from "zod";
import { type ApiResult, GitLabApi, GitLabError, type Query, type RequestOptions } from "../../app/ports/GitLabApi";
import { Settings } from "../../app/ports/Settings";
import { TokenStore } from "../../app/TokenStore";
import type { HostTarget } from "../../core/remote/remote";
import { Emitter } from "../../core/util/Emitter";

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TLS_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

type Response = Awaited<ReturnType<typeof fetch>>;
interface SendInit {
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** REST v4 + GraphQL via undici; one Agent per host when using `caFile` / `rejectUnauthorized: false`. */
@injectable()
export class GitLabHttp extends GitLabApi {
  private readonly unauthorized = new Emitter<string>();
  readonly onUnauthorized = this.unauthorized.event;
  private readonly agents = new Map<string, { key: string; agent: Agent }>();
  private readonly projectIds = new Map<string, Promise<number>>();

  constructor(
    private readonly tokens = inject(TokenStore),
    private readonly settings = inject(Settings),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    super();
  }

  async get<T>(
    target: HostTarget,
    path: string,
    query: Query,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const res = await this.send(target, this.url(target, `/api/v4${path}`, query), { method: "GET" }, options.token);
    const data = this.parse(target, schema, await this.json(target, res));
    const next = Number(res.headers.get("x-next-page"));
    return { data, nextPage: Number.isInteger(next) && next > 0 ? next : undefined };
  }

  async post<T>(target: HostTarget, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const res = await this.send(target, this.url(target, `/api/v4${path}`, {}), {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      headers: { "Content-Type": "application/json" },
    });
    return this.parse(target, schema, await this.json(target, res));
  }

  async getBytes(target: HostTarget, path: string, offset: number): Promise<Uint8Array> {
    const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const res = await this.send(
      target,
      this.url(target, `/api/v4${path}`, {}),
      { method: "GET", headers },
      undefined,
      [416],
    );
    if (res.status === 416) {
      await res.body?.cancel();
      return new Uint8Array();
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Server ignored Range (returned the full content with 200): trim previously received bytes.
    return res.status === 206 ? bytes : bytes.subarray(Math.min(offset, bytes.length));
  }

  async graphql<T>(
    target: HostTarget,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.send(target, this.url(target, "/api/graphql", {}), {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await this.json(target, res)) as { data?: unknown; errors?: { message?: string }[] } | null;
    if (body?.errors?.length) {
      throw new GitLabError("http", body.errors.map((e) => e.message ?? "GraphQL error").join("; "), target.host);
    }
    return this.parse(target, schema, body?.data);
  }

  dispose(): void {
    for (const { agent } of this.agents.values()) void agent.close();
    this.agents.clear();
    this.projectIds.clear();
    this.unauthorized.dispose();
  }

  private url(target: HostTarget, path: string, query: Query): URL {
    const url = new URL(target.apiUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return url;
  }

  private async send(
    target: HostTarget,
    url: URL,
    init: SendInit,
    tokenOverride?: string,
    acceptedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const token = tokenOverride ?? (await this.storedToken(target.host));
    const dispatcher = this.dispatcher(target.host);
    const origin = url.origin;
    let redirects = 0;
    let retries = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: init.method,
          // Evaluate each redirect before resending PRIVATE-TOKEN.
          redirect: "manual",
          headers: { Accept: "application/json", ...init.headers, "PRIVATE-TOKEN": token },
          ...(init.body !== undefined ? { body: init.body } : {}),
          ...(dispatcher ? { dispatcher } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw networkError(target.host, e);
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        let next: URL;
        try {
          if (!location) throw new Error("Missing Location");
          next = new URL(location, url);
        } catch {
          throw new GitLabError(
            "http",
            `GitLab returned ${res.status} with an invalid redirect location.`,
            target.host,
            res.status,
          );
        }
        if (next.origin !== origin || next.username || next.password) {
          // Do not follow redirects to a different origin, including port changes or HTTPS downgrades to HTTP.
          throw new GitLabError(
            "http",
            `GitLab returned ${res.status}, redirecting to ${next.origin}${next.pathname}. Configure gitlabCiView.hosts[].apiUrl with the canonical GitLab instance URL. The token was not forwarded to the redirect destination.`,
            target.host,
            res.status,
          );
        }
        if (init.method === "POST" && res.status !== 307 && res.status !== 308) {
          throw new GitLabError(
            "http",
            `GitLab returned ${res.status} for a POST request. Configure gitlabCiView.hosts[].apiUrl with the canonical GitLab instance URL.`,
            target.host,
            res.status,
          );
        }
        if (redirects++ >= MAX_REDIRECTS) {
          throw new GitLabError(
            "http",
            "GitLab returned too many redirects. Check gitlabCiView.hosts[].apiUrl and the reverse proxy configuration.",
            target.host,
            res.status,
          );
        }
        // Proxies decoding %2F in project paths break GitLab routing: use numeric IDs instead of paths.
        const project = /^(.*\/api\/v4\/projects\/)([^/]*%2f[^/]*)(\/.*)?$/i.exec(url.pathname);
        if (project && next.pathname === url.pathname.replace(/%2f/gi, "/")) {
          const projectPath = decodeURIComponent(project[2]!);
          const id = await this.projectId(target, projectPath, tokenOverride);
          url.pathname = `${project[1]}${id}${project[3] ?? ""}`;
        } else {
          url = next;
        }
        continue;
      }
      if (res.status === 429 && retries++ < MAX_RETRIES) {
        await res.body?.cancel();
        await this.sleep(retryAfterMs(res.headers.get("retry-after")));
        continue;
      }
      if (res.ok || acceptedStatuses.includes(res.status)) return res;
      throw await this.statusError(target.host, res, tokenOverride === undefined);
    }
  }

  private projectId(target: HostTarget, projectPath: string, token?: string): Promise<number> {
    const key = JSON.stringify([target.apiUrl, projectPath]);
    const cached = this.projectIds.get(key);
    if (cached) return cached;
    const loading = this.findProjectId(target, projectPath, token).catch((error: unknown) => {
      this.projectIds.delete(key);
      throw error;
    });
    this.projectIds.set(key, loading);
    return loading;
  }

  private async findProjectId(target: HostTarget, projectPath: string, token?: string): Promise<number> {
    const schema = z.array(z.object({ id: z.number().int().positive(), path_with_namespace: z.string() }));
    let page: number | undefined = 1;
    const visited = new Set<number>();
    while (page !== undefined && !visited.has(page) && visited.size < 100) {
      visited.add(page);
      const result: ApiResult<z.infer<typeof schema>> = await this.get(
        target,
        "/projects",
        { search: projectPath.split("/").at(-1), simple: "true", per_page: 100, page },
        schema,
        token === undefined ? {} : { token },
      );
      const match = result.data.find((p) => p.path_with_namespace.toLowerCase() === projectPath.toLowerCase());
      if (match) return match.id;
      page = result.nextPage;
    }
    throw new GitLabError(
      "notFound",
      `Cannot resolve the numeric ID of ${projectPath}. Check project access and the reverse proxy's encoded-slash handling.`,
      target.host,
      404,
    );
  }

  private async storedToken(host: string): Promise<string> {
    if (this.tokens.meta(host)?.invalid) {
      throw new GitLabError(
        "unauthorized",
        `GitLab rejected the token for ${host}. Update it with "Set GitLab token".`,
        host,
        401,
      );
    }
    const token = await this.tokens.token(host);
    if (!token) throw new GitLabError("noToken", `No GitLab token for ${host}.`, host);
    return token;
  }

  private async statusError(host: string, res: Response, storedToken: boolean): Promise<GitLabError> {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const body = JSON.parse(text) as { message?: unknown; error_description?: unknown; error?: unknown };
      const m = body.message ?? body.error_description ?? body.error;
      if (m !== undefined) message = typeof m === "string" ? m : JSON.stringify(m);
    } catch {
      if (text.trim() && text.length < 300) message = text.trim();
    }
    if (res.status === 401) {
      if (storedToken) this.unauthorized.fire(host);
      return new GitLabError("unauthorized", message, host, 401);
    }
    if (res.status === 403) return new GitLabError("forbidden", message, host, 403);
    if (res.status === 404) return new GitLabError("notFound", message, host, 404);
    return new GitLabError("http", message, host, res.status);
  }

  private async json(target: HostTarget, res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new GitLabError("invalidResponse", "GitLab returned a response that is not JSON.", target.host, res.status);
    }
  }

  private parse<T>(target: HostTarget, schema: z.ZodType<T>, value: unknown): T {
    const r = schema.safeParse(value);
    if (!r.success) {
      throw new GitLabError(
        "invalidResponse",
        `Unexpected response from GitLab: ${r.error.issues[0]?.message ?? "invalid"}`,
        target.host,
      );
    }
    return r.data;
  }

  private dispatcher(host: string): Agent | undefined {
    const s = this.settings.hosts().find((h) => h.host === host);
    if (!s || (!s.caFile && s.rejectUnauthorized !== false)) return undefined;
    const key = `${s.caFile ?? ""}|${s.rejectUnauthorized ?? true}`;
    const cached = this.agents.get(host);
    if (cached?.key === key) return cached.agent;
    if (cached) void cached.agent.close();
    let ca: string[] | undefined;
    if (s.caFile) {
      try {
        // `ca` replaces Node's default CAs: include rootCertificates so other hosts remain trusted.
        ca = [...rootCertificates, readFileSync(s.caFile.replace(/^~(?=$|\/)/, homedir()), "utf8")];
      } catch (e) {
        throw new GitLabError("tls", `Cannot read caFile for ${host}: ${(e as Error).message}`, host);
      }
    }
    const agent = new Agent({ connect: { rejectUnauthorized: s.rejectUnauthorized ?? true, ...(ca ? { ca } : {}) } });
    this.agents.set(host, { key, agent });
    return agent;
  }
}

export function networkError(host: string, e: unknown): GitLabError {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === "TimeoutError") return new GitLabError("timeout", `Timed out connecting to ${host}.`, host);
  const code = err.cause?.code;
  if (code && TLS_CODES.has(code)) {
    return new GitLabError(
      "tls",
      `TLS error for ${host} (${code}). If the instance uses a private CA, set "caFile" for it in gitlabCiView.hosts.`,
      host,
    );
  }
  return new GitLabError("network", err.cause?.message ?? err.message, host);
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 2000;
}
