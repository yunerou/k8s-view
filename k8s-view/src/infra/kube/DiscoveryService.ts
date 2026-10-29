import { inject, injectable } from "@needle-di/core";
import { ResourceKind } from "../../core/resource/ResourceKind";
import { KubeTransport } from "./KubeTransport";
import type { KindResolver } from "./WatchManager";

interface ApiResource {
  readonly name: string;
  readonly kind: string;
  readonly namespaced: boolean;
  readonly verbs?: readonly string[];
}

interface ApiGroup {
  readonly name: string;
  readonly versions: readonly { readonly groupVersion: string; readonly version: string }[];
  readonly preferredVersion?: { readonly version: string };
}

interface ContextCache {
  groups?: Promise<ApiGroup[]> | undefined;
  resources: Map<string, Promise<ResourceKind[]>>;
}

/** Map `group/kind` → preferred version, plural, namespaced; cached per context. */
@injectable()
export class DiscoveryService implements KindResolver {
  private readonly cache = new Map<string, ContextCache>();

  constructor(private readonly transport: KubeTransport = inject(KubeTransport)) {}

  invalidate(context?: string): void {
    if (context === undefined) this.cache.clear();
    else this.cache.delete(context);
  }

  async resolve(
    context: string,
    ref: { group: string; kind: string; version?: string },
  ): Promise<ResourceKind | undefined> {
    for (const version of await this.versionsOf(context, ref.group, ref.version)) {
      const found = (await this.resourcesOf(context, ref.group, version)).find((k) => k.kind === ref.kind);
      if (found) return found;
    }
    return undefined;
  }

  async hasGroups(context: string, groups: readonly string[]): Promise<boolean> {
    if (groups.length === 0) return true;
    const names = new Set((await this.groups(context)).map((g) => g.name));
    return groups.every((g) => g === "" || names.has(g));
  }

  /** Kinds supporting list+watch at each group's preferred version. */
  async listKinds(context: string): Promise<ResourceKind[]> {
    const groups = await this.groups(context);
    const lists = await Promise.all([
      this.resourcesOf(context, "", "v1"),
      ...groups.map((g) =>
        this.resourcesOf(context, g.name, g.preferredVersion?.version ?? g.versions[0]?.version ?? "v1").catch(
          () => [],
        ),
      ),
    ]);
    return lists.flat();
  }

  private async versionsOf(context: string, group: string, explicit: string | undefined): Promise<string[]> {
    if (explicit) return [explicit];
    if (group === "") return ["v1"];
    const g = (await this.groups(context)).find((x) => x.name === group);
    if (!g) return [];
    const preferred = g.preferredVersion?.version;
    return [...(preferred ? [preferred] : []), ...g.versions.map((v) => v.version).filter((v) => v !== preferred)];
  }

  private groups(context: string): Promise<ApiGroup[]> {
    const c = this.entry(context);
    c.groups ??= this.transport
      .getJson<{ groups?: ApiGroup[] }>(context, "/apis")
      .then((r) => r.groups ?? [])
      .catch((e) => {
        c.groups = undefined;
        throw e;
      });
    return c.groups;
  }

  private resourcesOf(context: string, group: string, version: string): Promise<ResourceKind[]> {
    const c = this.entry(context);
    const key = `${group}/${version}`;
    let p = c.resources.get(key);
    if (!p) {
      const path = group === "" ? `/api/${version}` : `/apis/${group}/${version}`;
      p = this.transport
        .getJson<{ resources?: ApiResource[] }>(context, path)
        .then((r) =>
          (r.resources ?? [])
            .filter((x) => !x.name.includes("/") && (x.verbs === undefined || x.verbs.includes("list")))
            .map((x) => new ResourceKind(group, version, x.kind, x.name, x.namespaced)),
        )
        .catch((e) => {
          if ((e as { status?: number }).status === 404) return [];
          c.resources.delete(key);
          throw e;
        });
      c.resources.set(key, p);
    }
    return p;
  }

  private entry(context: string): ContextCache {
    const existing = this.cache.get(context);
    if (existing) return existing;
    const created: ContextCache = { resources: new Map() };
    this.cache.set(context, created);
    return created;
  }
}
