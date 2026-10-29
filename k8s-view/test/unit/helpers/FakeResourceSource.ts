import { Disposable, EventEmitter } from "vscode";
import {
  type ContextLookup,
  type EntryInfo,
  type KindRef,
  type ResourceChange,
  type ResourceLease,
  ResourceSource,
  type SecretPayload,
  type WatchSummary,
} from "../../../src/app/ports/ResourceSource";
import type { ClusterContext } from "../../../src/core/context/ClusterContext";
import type { KubeObject, KubeResource } from "../../../src/core/resource/KubeResource";
import type { ResourceKind } from "../../../src/core/resource/ResourceKind";

const key = (ref: KindRef, ns: string | undefined) => `${ref.group}/${ref.kind}|${ns ?? "*"}`;

/** In-memory ResourceSource: tests set data per kind and inspect open leases. */
export class FakeResourceSource extends ResourceSource {
  readonly changed = new EventEmitter<ResourceChange>();
  readonly onDidChange = this.changed.event;
  readonly onDidChangeSummary = new EventEmitter<WatchSummary>().event;
  /** kindKey → discovered kind; missing = kind unavailable on the cluster. */
  kinds = new Map<string, ResourceKind>();
  data = new Map<string, KubeResource[]>();
  states = new Map<string, EntryInfo>();
  leases = new Map<string, number>();
  acquired: string[] = [];
  resynced = 0;
  groups = new Set<string>();
  isPaused = false;

  addKind(...kinds: ResourceKind[]) {
    for (const k of kinds) {
      this.kinds.set(k.key, k);
      this.groups.add(k.group);
    }
  }

  /** Set fully listed data for a kind in a namespace and emit a change. */
  set(ref: KindRef, ns: string | undefined, items: KubeResource[], context = "dev") {
    this.data.set(key(ref, ns), items);
    this.changed.fire({ context, kindKey: `${ref.group}/${ref.kind}`, namespace: ns });
  }

  setState(ref: KindRef, ns: string | undefined, info: EntryInfo, context = "dev") {
    this.states.set(key(ref, ns), info);
    this.changed.fire({ context, kindKey: `${ref.group}/${ref.kind}`, namespace: ns });
  }

  active(): string[] {
    return [...this.leases.entries()]
      .filter(([, n]) => n > 0)
      .map(([k]) => k)
      .sort();
  }

  acquire(_ctx: ClusterContext, ref: KindRef, ns: string | undefined): ResourceLease {
    const k = key(ref, ns);
    this.acquired.push(k);
    this.leases.set(k, (this.leases.get(k) ?? 0) + 1);
    let disposed = false;
    const lease = new Disposable(() => {
      if (disposed) return;
      disposed = true;
      this.leases.set(k, (this.leases.get(k) ?? 1) - 1);
    });
    return Object.assign(lease, { key: k });
  }

  lookup(): ContextLookup {
    const items = (ref: KindRef, ns: string | undefined): readonly KubeResource[] | undefined => {
      const kind = this.kinds.get(`${ref.group}/${ref.kind}`);
      if (!kind) return [];
      const state = this.states.get(key(ref, ns));
      if (state?.state === "forbidden") return [];
      const own = this.data.get(key(ref, kind.namespaced ? ns : undefined));
      if (own) return own;
      const all = this.data.get(key(ref, undefined));
      return all?.filter((r) => ns === undefined || !kind.namespaced || r.namespace === ns);
    };
    return {
      list: (group, kind, ns) => items({ group, kind }, ns),
      byOwner: (group, kind, uid) => {
        let found: KubeResource[] | undefined;
        for (const [k, list] of this.data) {
          if (!k.startsWith(`${group}/${kind}|`)) continue;
          found = [...(found ?? []), ...list.filter((r) => r.ownerUids.includes(uid))];
        }
        if (!found && !this.kinds.has(`${group}/${kind}`)) return [];
        return found;
      },
      entry: (ref, ns) => {
        const state = this.states.get(key(ref, ns));
        if (state) return state;
        if (!this.kinds.has(`${ref.group}/${ref.kind}`)) return { state: "unavailable" };
        return this.data.has(key(ref, ns)) ? { state: "live" } : { state: "loading" };
      },
    };
  }

  async resolveKind(_ctx: ClusterContext, ref: KindRef) {
    return this.kinds.get(`${ref.group}/${ref.kind}`);
  }
  async hasGroups(_ctx: ClusterContext, groups: readonly string[]) {
    return groups.every((g) => this.groups.has(g));
  }
  async listKinds() {
    return [...this.kinds.values()];
  }
  async get(): Promise<KubeResource> {
    throw new Error("not implemented");
  }
  async readSecretValue(): Promise<string> {
    return "secret";
  }
  secrets = new Map<string, SecretPayload>();
  async readSecret(_ctx: ClusterContext, namespace: string, name: string): Promise<SecretPayload> {
    const secret = this.secrets.get(`${namespace}/${name}`);
    if (!secret) throw new Error(`secret ${namespace}/${name} not found`);
    return secret;
  }
  async listNames(_ctx: ClusterContext, ref: KindRef, ns: string | undefined): Promise<string[]> {
    const items = this.lookup().list(ref.group, ref.kind, ns) ?? [];
    return items.map((r) => r.name).sort();
  }
  async listResources(_ctx: ClusterContext, ref: KindRef, ns: string | undefined): Promise<KubeResource[]> {
    return [...(this.lookup().list(ref.group, ref.kind, ns) ?? [])];
  }
  async events(): Promise<KubeObject[]> {
    return [];
  }
  resync() {
    this.resynced++;
  }
  setPaused(p: boolean) {
    this.isPaused = p;
  }
  get paused() {
    return this.isPaused;
  }
  summary(): WatchSummary {
    return { state: "live", watches: this.active().length, errors: 0 };
  }
}
