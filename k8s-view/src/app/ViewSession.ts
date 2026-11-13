import * as vscode from "vscode";
import type { ClusterContext } from "../core/context/ClusterContext";
import { stringify } from "../core/expression/ExpressionEngine";
import type { KubeResource } from "../core/resource/KubeResource";
import { metricRef, withResourceMetrics } from "../core/resource/resourceMetrics";
import { type ParentHit, ParentIndex } from "../core/view/ParentIndex";
import type { ChildItem, KindDemand } from "../core/view/RelationResolver";
import {
  EMPTY_SCOPE_RESOLUTION,
  resolveScope,
  type ScopeResolution,
  type ScopeSource,
} from "../core/view/ScopeResolver";
import type { ChildDefinition, SectionDefinition, ViewDefinition } from "../core/view/ViewDefinition";
import type { ContextService } from "./ContextService";
import type { EntryState, KindRef, ResourceLease, ResourceSource } from "./ports/ResourceSource";
import type { Settings } from "./ports/Settings";
import type { RegisteredView } from "./ViewRegistry";

export interface SectionProblem {
  readonly kind: string;
  readonly state: EntryState;
  readonly message: string | undefined;
}

export interface SectionContent {
  readonly state: "loading" | "ready";
  readonly items: readonly KubeResource[];
  /** Based on the section's `groupBy`; `undefined` when not grouped. */
  readonly groups: readonly { readonly key: string; readonly items: readonly KubeResource[] }[] | undefined;
  readonly problems: readonly SectionProblem[];
}

export interface ChildContent {
  readonly def: ChildDefinition;
  readonly items: readonly ChildItem[];
  readonly pending: boolean;
  /** Hint instead of an error (e.g. missing cluster-wide list permission). */
  readonly hints: readonly string[];
}

export interface ParentContent {
  readonly items: readonly ParentHit[];
  readonly pending: boolean;
  readonly hints: readonly string[];
}

/** Lease owners: each holds its own leases, released when it is hidden. */
export type LeaseOwner = "tree" | "table";

const kindKey = (r: KindRef) => `${r.group}/${r.kind}`;
const leaseKey = (r: KindRef, ns: string | undefined) => `${kindKey(r)}|${ns ?? "*"}`;

/**
 * A view bound to the current context: lazily acquire watches for open sections/nodes, release them on close,
 * build tree/table content, and emit debounced `onDidChange` events when relevant data changes.
 */
export class ViewSession implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly owners = new Map<string, Map<string, ResourceLease>>();
  private kindAvailable = new Map<string, boolean>();
  private viewAvailable = true;
  /** Available cluster kinds are known (discovery completed). */
  private availabilityKnown = false;
  private ready: Promise<void> = Promise.resolve();
  private readonly visibleOwners = new Set<LeaseOwner>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private scopeEnabled = true;
  private sourceMissing = false;
  /** Scope resolution shared by every section until the store, context, index or scope toggle changes. */
  private scopeCache:
    | { readonly ctx: ClusterContext; readonly index: ParentIndex; readonly result: ScopeResolution }
    | undefined;
  /** Open scoped sections per lease owner (`tree`/`table`); the scope's leases live under `<owner>:scope`. */
  private readonly scopedSections = new Map<string, Set<string>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private registered: RegisteredView,
    private readonly contexts: Pick<ContextService, "current" | "onDidChange">,
    private readonly source: ResourceSource,
    private readonly settings: Settings,
    private readonly parentIndex: () => ParentIndex = () => ParentIndex.empty,
  ) {
    this.disposables.push(
      contexts.onDidChange(() => this.reset()),
      source.onDidChange((c) => {
        if (c.context !== this.context?.name) return;
        this.scopeCache = undefined;
        if (this.watches(c.kindKey)) this.schedule();
      }),
    );
    this.ready = this.computeAvailability();
  }

  get definition(): ViewDefinition {
    return this.registered.definition;
  }

  get view(): RegisteredView {
    return this.registered;
  }

  get context(): ClusterContext | undefined {
    return this.contexts.current;
  }

  /** The cluster satisfies the view's `requires`. */
  get available(): boolean {
    return this.viewAvailable;
  }

  get isVisible(): boolean {
    return this.visibleOwners.size > 0;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /** `false` while discovery is incomplete: visible sections are not yet known. */
  get resolved(): boolean {
    return this.availabilityKnown;
  }

  /** Replace the definition (config changed): close all leases and recalculate available cluster kinds. */
  update(view: RegisteredView): void {
    this.registered = view;
    this.reset();
  }

  /** Hiding `owner` releases only its leases (`<owner>:…`): a hidden tree does not keep watches for a visible table. */
  setVisible(owner: LeaseOwner, visible: boolean): void {
    if (this.visibleOwners.has(owner) === visible) return;
    if (visible) {
      this.visibleOwners.add(owner);
      this.changed.fire();
      return;
    }
    this.visibleOwners.delete(owner);
    for (const key of [...this.owners.keys()]) if (key.startsWith(`${owner}:`)) this.release(key);
    this.scopedSections.delete(owner);
  }

  sections(): SectionDefinition[] {
    return this.definition.sections.filter(
      (s) => !s.hidden && s.resources.some((r) => this.kindAvailable.get(kindKey(r)) === true),
    );
  }

  sectionDefinition(id: string): SectionDefinition | undefined {
    return this.definition.sections.find((s) => s.id === id);
  }

  /** Open Related / Open Parent: turn the scope filter off (all resources of the kinds) or back on. */
  setScopeEnabled(enabled: boolean): void {
    if (this.scopeEnabled === enabled) return;
    this.scopeEnabled = enabled;
    this.scopeCache = undefined;
    this.changed.fire();
  }

  scopeState(): { readonly enabled: boolean; readonly sourceMissing: boolean } | undefined {
    return this.registered.scope
      ? { enabled: this.scopeEnabled, sourceMissing: this.scopeEnabled && this.sourceMissing }
      : undefined;
  }

  /**
   * Resolve the view's scope (when enabled; once per store change, shared by all sections) and hold leases for the
   * kinds it needs under `<owner>:scope` while a scoped section of `owner` is open (unless `hold` is off).
   */
  private activeScope(
    ctx: ClusterContext,
    owner: LeaseOwner,
    sectionId: string,
    hold: boolean,
  ): { readonly source: ScopeSource; readonly result: ScopeResolution } | undefined {
    const scope = this.registered.scope;
    if (!scope) return undefined;
    const leaseOwner = `${owner}:scope`;
    if (hold) {
      const open = this.scopedSections.get(owner) ?? new Set<string>();
      open.add(sectionId);
      this.scopedSections.set(owner, open);
    }
    if (!this.scopeEnabled) {
      if (hold) this.release(leaseOwner);
      this.sourceMissing = false;
      return undefined;
    }
    if (scope.context !== ctx.name) {
      if (hold) this.release(leaseOwner);
      return { source: scope.source, result: EMPTY_SCOPE_RESOLUTION };
    }
    const index = this.parentIndex();
    const cached = this.scopeCache;
    const result =
      cached && cached.ctx === ctx && cached.index === index
        ? cached.result
        : resolveScope(scope, this.source.lookup(ctx), index, ctx.scope.type === "all");
    this.scopeCache = { ctx, index, result };
    if (hold) this.hold(leaseOwner, result.demands);
    this.sourceMissing = result.sourceMissing;
    return { source: scope.source, result };
  }

  /**
   * `owner` separates tree and table leases: closing a tree section does not remove the table's data.
   * `hold: false` acquires nothing and returns what the shared store already has (inactive table tabs).
   */
  openSection(id: string, owner: LeaseOwner = "tree", { hold = true }: { hold?: boolean } = {}): SectionContent {
    const section = this.sectionDefinition(id);
    const ctx = this.context;
    if (!section || !ctx) return { state: "ready", items: [], groups: undefined, problems: [] };
    const refs = section.resources.filter((r) => this.kindAvailable.get(kindKey(r)) === true);
    const lookup = this.source.lookup(ctx);
    const scope = this.activeScope(ctx, owner, id, hold);
    const namespace = scope ? scope.source.namespace : section.allNamespaces ? undefined : ctx.namespace;
    /** Scoped sections watch where the scope's resources live; without list permission there, fall back to the source's namespace. */
    const namespacesOf = (ref: KindRef): (string | undefined)[] => {
      if (!scope) return [namespace];
      const wanted = [
        ...new Set(
          scope.result.demands.filter((d) => d.group === ref.group && d.kind === ref.kind).map((d) => d.namespace),
        ),
      ];
      const list = wanted.length > 0 ? wanted : [scope.source.namespace];
      const fallback = scope.source.namespace;
      return list.includes(undefined) &&
        fallback !== undefined &&
        !list.includes(fallback) &&
        lookup.entry(ref, undefined)?.state === "forbidden"
        ? [...list, fallback]
        : list;
    };
    // The tree shows no columns: it needs metrics only to sort by a metric column.
    const metricColumns = owner === "tree" ? section.columns.filter((c) => c.id === section.sort?.by) : section.columns;
    const metricKinds = metricColumns.some((c) => c.usesMetrics)
      ? refs.filter((r) => r.group === "" && (r.kind === "Pod" || r.kind === "Node"))
      : [];
    const dependencies = metricKinds.map((r) => ({
      ...metricRef(r.kind),
      namespace: r.kind === "Node" ? undefined : namespace,
    }));
    if (metricKinds.some((r) => r.kind === "Node")) dependencies.push({ group: "", kind: "Pod", namespace: undefined });
    if (hold)
      this.hold(`${owner}:section:${id}`, [
        ...refs.flatMap((r) => namespacesOf(r).map((ns) => ({ group: r.group, kind: r.kind, namespace: ns }))),
        ...dependencies,
      ]);
    let loading = false;
    const problems: SectionProblem[] = [];
    const items: KubeResource[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      for (const ns of namespacesOf(ref)) {
        const entry = lookup.entry(ref, ns);
        if (entry && (entry.state === "forbidden" || entry.state === "error")) {
          problems.push({ kind: ref.kind, state: entry.state, message: entry.message });
        }
        const list = lookup.list(ref.group, ref.kind, ns);
        if (list === undefined) {
          loading = true;
          continue;
        }
        for (const r of list) {
          if (seen.has(r.uid) || !section.accepts(r) || (scope && !scope.result.uids.has(r.uid))) continue;
          seen.add(r.uid);
          items.push(r);
        }
      }
    }
    for (const d of dependencies) {
      const entry = lookup.entry(d, d.namespace);
      if (entry && ["forbidden", "error", "unavailable"].includes(entry.state)) {
        problems.push({ kind: d.kind, state: entry.state, message: entry.message });
      }
    }
    const metricsByResource = new Map<string, KubeResource>();
    const podsByNode = new Map<string, KubeResource[]>();
    let nodePodsKnown = false;
    for (const ref of metricKinds) {
      const metric = metricRef(ref.kind);
      const ns = ref.kind === "Node" ? undefined : namespace;
      const state = lookup.entry(metric, ns)?.state;
      if (state !== "error" && state !== "forbidden" && state !== "unavailable") {
        for (const m of lookup.list(metric.group, metric.kind, ns) ?? []) {
          metricsByResource.set(`${ref.kind}/${m.namespace ?? ""}/${m.name}`, m);
        }
      }
      if (ref.kind !== "Node") continue;
      const podState = lookup.entry({ group: "", kind: "Pod" }, undefined)?.state;
      if (podState === "error" || podState === "forbidden" || podState === "unavailable") continue;
      const pods = lookup.list("", "Pod", undefined);
      nodePodsKnown = pods !== undefined;
      for (const pod of pods ?? []) {
        const name = (pod.object["spec"] as { nodeName?: string } | undefined)?.nodeName;
        if (!name) continue;
        const group = podsByNode.get(name) ?? [];
        group.push(pod);
        podsByNode.set(name, group);
      }
    }
    const enriched = items.map((r) => {
      if (!metricKinds.some((ref) => ref.group === r.kind.group && ref.kind === r.kind.kind)) return r;
      const metric = metricsByResource.get(`${r.kind.kind}/${r.namespace ?? ""}/${r.name}`);
      return withResourceMetrics(r, metric, nodePodsKnown ? (podsByNode.get(r.name) ?? []) : undefined);
    });
    const sortedItems = this.sort(section, enriched);
    return {
      state: loading && items.length === 0 ? "loading" : "ready",
      items: sortedItems,
      groups: section.groupBy ? groupItems(section, sortedItems) : undefined,
      problems,
    };
  }

  closeSection(id: string, owner: LeaseOwner = "tree"): void {
    this.release(`${owner}:section:${id}`);
    const open = this.scopedSections.get(owner);
    if (!open?.delete(id) || open.size > 0) return;
    this.scopedSections.delete(owner);
    this.release(`${owner}:scope`);
  }

  /** Node children resolved through relations; leases are held under `nodeKey` until `closeNode`. */
  openChildren(nodeKey: string, parent: KubeResource, defs: readonly ChildDefinition[]): ChildContent[] {
    const ctx = this.context;
    if (!ctx) return [];
    const lookup = this.source.lookup(ctx);
    const demands: KindDemand[] = [];
    const out = defs
      .filter((d) => !d.hidden)
      .map((def): ChildContent => {
        const hints: string[] = [];
        const resolution = def.relation.resolve(parent, lookup);
        for (const d of resolution.demands) {
          const ns = ctx.scope.type === "all" ? undefined : d.namespace;
          demands.push({ ...d, namespace: ns });
          if (ns === undefined && ctx.namespace && lookup.entry(d, undefined)?.state === "forbidden") {
            demands.push({ ...d, namespace: ctx.namespace });
            hints.push(
              `Showing ${d.kind} from only namespace ${ctx.namespace}: no permission to list them in all namespaces.`,
            );
          }
        }
        // After falling back, read again using the selected namespace.
        const items = hints.length > 0 ? this.fallbackResolve(def, parent, ctx.namespace!) : resolution.items;
        return {
          def,
          items: items.filter((i) => i.type !== "resource" || def.accepts(i.resource)),
          pending: resolution.pending,
          hints,
        };
      });
    this.hold(nodeKey, demands);
    return out;
  }

  /** Parents of `child` (owners + reversed view relations); leases are held under `nodeKey` until `closeNode`. */
  openParents(nodeKey: string, child: KubeResource, index: ParentIndex): ParentContent {
    const ctx = this.context;
    if (!ctx) return { items: [], pending: false, hints: [] };
    const lookup = this.source.lookup(ctx);
    const result = index.parents(child, lookup, ctx.scope.type === "all");
    const demands: KindDemand[] = [...result.demands];
    const hints: string[] = [];
    for (const d of result.demands) {
      if (d.namespace === undefined && ctx.namespace && lookup.entry(d, undefined)?.state === "forbidden") {
        demands.push({ ...d, namespace: ctx.namespace });
        hints.push(
          `Showing ${d.kind} from only namespace ${ctx.namespace}: no permission to list them in all namespaces.`,
        );
      }
    }
    this.hold(nodeKey, demands);
    return { items: result.items, pending: result.pending, hints };
  }

  /** Release leases for the node and all its descendants. */
  closeNode(nodeKey: string): void {
    for (const owner of [...this.owners.keys()]) {
      if (owner === nodeKey || owner.startsWith(`${nodeKey}/`)) this.release(owner);
    }
  }

  refresh(): void {
    const ctx = this.context;
    if (!ctx) return;
    const refs = new Map(this.definition.kinds.map((r) => [kindKey(r), r]));
    for (const leases of this.owners.values()) {
      for (const key of leases.keys()) {
        const [group, kind] = key.split("|")[0]!.split("/");
        if (kind) refs.set(`${group}/${kind}`, { group: group!, kind });
      }
    }
    this.source.resync(ctx, [...refs.values()]);
  }

  dispose(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.releaseAll();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }

  private fallbackResolve(def: ChildDefinition, parent: KubeResource, namespace: string): readonly ChildItem[] {
    const ctx = this.context!;
    const base = this.source.lookup(ctx);
    const scoped = {
      list: (group: string, kind: string, ns: string | undefined) => base.list(group, kind, ns ?? namespace),
      byOwner: base.byOwner.bind(base),
    };
    return def.relation.resolve(parent, scoped).items;
  }

  private sort(section: SectionDefinition, items: KubeResource[]): KubeResource[] {
    const spec = section.sort ?? { by: "name", order: "asc" as const };
    const now = Date.now();
    const column = section.columns.find((c) => c.id === spec.by);
    const keyOf = (r: KubeResource): string | number => {
      switch (spec.by) {
        case "name":
          return r.name;
        case "namespace":
          return `${r.namespace ?? ""}/${r.name}`;
        case "kind":
          return `${r.kind.kind}/${r.name}`;
        case "age":
          return -(Date.parse(r.creationTimestamp ?? "") || 0);
        case "status":
          return section.status(r).level;
        default:
          if (column) return column.evaluate(r, now).sort ?? "";
          return stringify(section.sortPath?.first(r.object));
      }
    };
    const factor = spec.order === "desc" ? -1 : 1;
    return items
      .map((r) => ({ r, k: keyOf(r) }))
      .sort(
        (a, b) =>
          factor * compare(a.k, b.k) ||
          compare(a.r.name, b.r.name) ||
          compare(a.r.namespace ?? "", b.r.namespace ?? ""),
      )
      .map((x) => x.r);
  }

  private hold(owner: string, demands: readonly KindDemand[]): void {
    const ctx = this.context;
    if (!ctx) return;
    const current = this.owners.get(owner) ?? new Map<string, ResourceLease>();
    const wanted = new Map(demands.map((d) => [leaseKey(d, d.namespace), d]));
    for (const [key, lease] of current) {
      if (!wanted.has(key)) {
        lease.dispose();
        current.delete(key);
      }
    }
    for (const [key, d] of wanted) {
      if (!current.has(key)) current.set(key, this.source.acquire(ctx, { group: d.group, kind: d.kind }, d.namespace));
    }
    if (current.size > 0) this.owners.set(owner, current);
    else this.owners.delete(owner);
  }

  private release(owner: string): void {
    for (const lease of this.owners.get(owner)?.values() ?? []) lease.dispose();
    this.owners.delete(owner);
  }

  private releaseAll(): void {
    for (const owner of [...this.owners.keys()]) this.release(owner);
    this.scopedSections.clear();
    this.scopeCache = undefined;
  }

  private watches(kind: string): boolean {
    for (const leases of this.owners.values()) {
      for (const key of leases.keys()) if (key.startsWith(`${kind}|`)) return true;
    }
    return false;
  }

  private schedule(): void {
    const delay = this.settings.debounceMs();
    if (delay <= 0) {
      this.changed.fire();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire();
    }, delay);
  }

  private reset(): void {
    this.releaseAll();
    this.kindAvailable = new Map();
    this.availabilityKnown = false;
    this.ready = this.computeAvailability();
    this.changed.fire();
  }

  private async computeAvailability(): Promise<void> {
    const generation = ++this.generation;
    const ctx = this.context;
    if (!ctx) return;
    const view = this.definition;
    const refs = new Map<string, KindRef>();
    for (const s of view.sections) for (const r of s.resources) refs.set(kindKey(r), r);
    try {
      const [requires, ...found] = await Promise.all([
        this.source.hasGroups(ctx, view.requires),
        ...[...refs.values()].map((r) => this.source.resolveKind(ctx, r)),
      ]);
      if (generation !== this.generation) return;
      this.viewAvailable = requires as boolean;
      const keys = [...refs.keys()];
      this.kindAvailable = new Map(keys.map((k, i) => [k, found[i] !== undefined]));
    } catch {
      if (generation !== this.generation) return;
      // Discovery failed (disconnected): keep all sections; errors appear on individual watches.
      this.viewAvailable = true;
      this.kindAvailable = new Map([...refs.keys()].map((k) => [k, true]));
    }
    this.availabilityKnown = true;
    this.changed.fire();
  }
}

function groupItems(section: SectionDefinition, items: readonly KubeResource[]) {
  const groups = new Map<string, KubeResource[]>();
  for (const r of items) {
    const key = section.groupKey(r) ?? "";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([key, list]) => ({ key, items: list }));
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}
