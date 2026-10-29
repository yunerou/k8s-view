import * as vscode from "vscode";
import type { ClusterContext } from "../core/context/ClusterContext";
import { stringify } from "../core/expression/ExpressionEngine";
import type { KubeResource } from "../core/resource/KubeResource";
import { metricRef, withResourceMetrics } from "../core/resource/resourceMetrics";
import type { ChildItem, KindDemand } from "../core/view/RelationResolver";
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
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private registered: RegisteredView,
    private readonly contexts: ContextService,
    private readonly source: ResourceSource,
    private readonly settings: Settings,
  ) {
    this.disposables.push(
      contexts.onDidChange(() => this.reset()),
      source.onDidChange((c) => {
        if (c.context === this.context?.name && this.watches(c.kindKey)) this.schedule();
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
    return this.visible;
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

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) this.releaseAll();
    else this.changed.fire();
  }

  sections(): SectionDefinition[] {
    return this.definition.sections.filter(
      (s) => !s.hidden && s.resources.some((r) => this.kindAvailable.get(kindKey(r)) === true),
    );
  }

  sectionDefinition(id: string): SectionDefinition | undefined {
    return this.definition.sections.find((s) => s.id === id);
  }

  /** `owner` separates tree and table leases: closing a tree section does not remove the table's data. */
  openSection(id: string, owner = "tree"): SectionContent {
    const section = this.sectionDefinition(id);
    const ctx = this.context;
    if (!section || !ctx) return { state: "ready", items: [], groups: undefined, problems: [] };
    const refs = section.resources.filter((r) => this.kindAvailable.get(kindKey(r)) === true);
    const namespace = section.allNamespaces ? undefined : ctx.namespace;
    const metricKinds = section.columns.some((c) => c.usesMetrics)
      ? refs.filter((r) => r.group === "" && (r.kind === "Pod" || r.kind === "Node"))
      : [];
    const dependencies = metricKinds.map((r) => ({
      ...metricRef(r.kind),
      namespace: r.kind === "Node" ? undefined : namespace,
    }));
    if (metricKinds.some((r) => r.kind === "Node")) dependencies.push({ group: "", kind: "Pod", namespace: undefined });
    this.hold(`${owner}:section:${id}`, [
      ...refs.map((r) => ({ group: r.group, kind: r.kind, namespace })),
      ...dependencies,
    ]);
    const lookup = this.source.lookup(ctx);
    let loading = false;
    const problems: SectionProblem[] = [];
    const items: KubeResource[] = [];
    for (const ref of refs) {
      const entry = lookup.entry(ref, namespace);
      if (entry && (entry.state === "forbidden" || entry.state === "error")) {
        problems.push({ kind: ref.kind, state: entry.state, message: entry.message });
      }
      const list = lookup.list(ref.group, ref.kind, namespace);
      if (list === undefined) loading = true;
      else items.push(...list.filter((r) => section.accepts(r)));
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

  closeSection(id: string, owner = "tree"): void {
    this.release(`${owner}:section:${id}`);
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
