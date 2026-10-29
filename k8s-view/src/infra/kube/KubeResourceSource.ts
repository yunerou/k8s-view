import { inject, injectable } from "@needle-di/core";
import type * as vscode from "vscode";
import {
  type ContextLookup,
  type KindRef,
  type ResourceChange,
  type ResourceLease,
  ResourceSource,
  type SecretPayload,
  type WatchSummary,
} from "../../app/ports/ResourceSource";
import type { ClusterContext } from "../../core/context/ClusterContext";
import { type KubeObject, KubeResource, normalizeObject } from "../../core/resource/KubeResource";
import type { ResourceKind } from "../../core/resource/ResourceKind";
import { DiscoveryService } from "./DiscoveryService";
import { KubeTransport } from "./KubeTransport";
import { type WatchEntryInfo, WatchManager } from "./WatchManager";

/** ResourceSource adapter: watch + store (WatchManager), discovery, fresh GET. */
@injectable()
export class KubeResourceSource extends ResourceSource {
  readonly onDidChange: vscode.Event<ResourceChange>;
  readonly onDidChangeSummary: vscode.Event<WatchSummary>;

  constructor(
    private readonly watches: WatchManager = inject(WatchManager),
    private readonly discovery: DiscoveryService = inject(DiscoveryService),
    private readonly transport: KubeTransport = inject(KubeTransport),
  ) {
    super();
    this.onDidChange = watches.onDidChange;
    this.onDidChangeSummary = watches.onDidChangeSummary;
  }

  acquire(ctx: ClusterContext, ref: KindRef, namespace: string | undefined): ResourceLease {
    return this.watches.acquire(ctx.name, ref, namespace);
  }

  lookup(ctx: ClusterContext): ContextLookup {
    const infos = (group: string, kind: string) => this.watches.entriesFor(ctx.name, { group, kind });
    const items = (group: string, kind: string, ns: string | undefined): readonly KubeResource[] | undefined => {
      const all = infos(group, kind);
      if (all.some((i) => i.state === "unavailable")) return [];
      const resolved = all.find((i) => i.kind)?.kind;
      if (resolved && !resolved.namespaced) {
        const loaded = all.find((i) => i.store);
        return loaded ? loaded.store!.items() : settled(all);
      }
      const exact = all.find((i) => i.namespace === ns);
      if (ns === undefined) {
        if (exact?.state === "forbidden") {
          const fallback = ctx.namespace ? all.find((i) => i.namespace === ctx.namespace && i.store) : undefined;
          return fallback ? fallback.store!.items() : [];
        }
        return exact?.store ? exact.store.items() : exact ? settled([exact]) : undefined;
      }
      if (exact?.store && exact.state !== "forbidden") return exact.store.items();
      const wide = all.find((i) => i.namespace === undefined && i.store && i.state !== "forbidden");
      if (wide) return wide.store!.items().filter((r) => r.namespace === ns);
      return exact ? settled([exact]) : undefined;
    };
    return {
      list: items,
      byOwner: (group, kind, uid) => {
        const all = infos(group, kind);
        const loaded = all.filter((i) => i.store);
        if (loaded.length === 0) return all.some((i) => i.state === "unavailable") ? [] : undefined;
        const seen = new Map<string, KubeResource>();
        for (const i of loaded) for (const r of i.store!.byOwner(uid)) seen.set(r.uid, r);
        return [...seen.values()];
      },
      entry: (ref, ns) => {
        const e = this.watches.entry(ctx.name, ref, ns);
        return (
          e && { state: e.state, ...(e.message ? { message: e.message } : {}), ...(e.kind ? { kind: e.kind } : {}) }
        );
      },
    };
  }

  resolveKind(ctx: ClusterContext, ref: KindRef): Promise<ResourceKind | undefined> {
    return this.discovery.resolve(ctx.name, ref);
  }

  hasGroups(ctx: ClusterContext, groups: readonly string[]): Promise<boolean> {
    return this.discovery.hasGroups(ctx.name, groups);
  }

  listKinds(ctx: ClusterContext): Promise<ResourceKind[]> {
    return this.discovery.listKinds(ctx.name);
  }

  async get(
    ctx: ClusterContext,
    kind: ResourceKind,
    namespace: string | undefined,
    name: string,
  ): Promise<KubeResource> {
    const raw = await this.transport.getJson<KubeObject>(ctx.name, kind.itemPath(namespace, name));
    return new KubeResource(kind, normalizeObject(kind, { ...raw, apiVersion: kind.apiVersion, kind: kind.kind }));
  }

  async readSecretValue(ctx: ClusterContext, namespace: string, name: string, key: string): Promise<string> {
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;
    const secret = await this.transport.getJson<{ data?: Record<string, string> }>(ctx.name, path);
    const value = secret.data?.[key];
    if (value === undefined) throw new Error(`Secret ${namespace}/${name} has no key '${key}'`);
    return Buffer.from(value, "base64").toString("utf8");
  }

  async readSecret(ctx: ClusterContext, namespace: string, name: string): Promise<SecretPayload> {
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;
    const secret = await this.transport.getJson<{ type?: string; data?: Record<string, string> }>(ctx.name, path);
    return { type: secret.type, data: secret.data ?? {} };
  }

  async listNames(ctx: ClusterContext, ref: KindRef, namespace: string | undefined): Promise<string[]> {
    const kind = await this.discovery.resolve(ctx.name, ref);
    if (!kind) throw new Error(`${ref.kind} is not served by context ${ctx.name}`);
    const { items } = await this.transport.list(ctx.name, kind, kind.namespaced ? namespace : undefined);
    return [...new Set(items.map((o) => o.metadata.name))].sort();
  }

  async listResources(
    ctx: ClusterContext,
    ref: KindRef,
    namespace: string | undefined,
    labelSelector?: string,
  ): Promise<KubeResource[]> {
    const kind = await this.discovery.resolve(ctx.name, ref);
    if (!kind) throw new Error(`${ref.kind} is not served by context ${ctx.name}`);
    const query = labelSelector ? { labelSelector } : {};
    const { items } = await this.transport.list(ctx.name, kind, kind.namespaced ? namespace : undefined, query);
    return items.map(
      (o) => new KubeResource(kind, normalizeObject(kind, { ...o, apiVersion: kind.apiVersion, kind: kind.kind })),
    );
  }

  async events(ctx: ClusterContext, resource: KubeResource): Promise<KubeObject[]> {
    const path = resource.namespace
      ? `/api/v1/namespaces/${encodeURIComponent(resource.namespace)}/events`
      : "/api/v1/events";
    const list = await this.transport.getJson<{ items?: KubeObject[] }>(ctx.name, path, {
      fieldSelector: `involvedObject.uid=${resource.uid}`,
    });
    const time = (e: KubeObject) =>
      Date.parse(String(e["lastTimestamp"] ?? e["eventTime"] ?? e.metadata.creationTimestamp ?? "")) || 0;
    return (list.items ?? []).sort((a, b) => time(b) - time(a));
  }

  resync(ctx: ClusterContext, refs?: readonly KindRef[]): void {
    if (!refs) this.discovery.invalidate(ctx.name);
    this.watches.resync(ctx.name, refs);
  }

  setPaused(paused: boolean): void {
    this.watches.setPaused(paused);
  }

  get paused(): boolean {
    return this.watches.isPaused;
  }

  summary(): WatchSummary {
    return this.watches.summary();
  }

  /** Context switch: immediately close watches for the previous context. */
  closeContextsExcept(context: string | undefined): void {
    this.watches.closeContextsExcept(context);
  }
}

/** Entry has a final result (error, forbidden, kind unavailable) but no store: empty list rather than "loading". */
function settled(entries: readonly WatchEntryInfo[]): readonly KubeResource[] | undefined {
  return entries.some((e) => e.state === "forbidden" || e.state === "error" || e.state === "unavailable")
    ? []
    : undefined;
}
