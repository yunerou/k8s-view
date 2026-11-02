import type { KubeResource } from "../resource/KubeResource";
import type { ParentIndex } from "./ParentIndex";
import type { KindDemand, ResourceLookup } from "./RelationResolver";
import type { ChildDefinition } from "./ViewDefinition";

export type ScopeDirection = "related" | "parents";

export interface ScopeSource {
  readonly group: string;
  readonly kind: string;
  readonly namespace: string | undefined;
  readonly name: string;
  readonly uid: string;
}

/** Scope of an Open Related / Open Parent tab. */
export interface ViewScope {
  readonly direction: ScopeDirection;
  readonly source: ScopeSource;
  /** Context the source belongs to. */
  readonly context: string;
  /** Related: the source section's children; empty for parents. */
  readonly children: readonly ChildDefinition[];
}

export interface ScopeResolution {
  readonly uids: ReadonlySet<string>;
  readonly found: readonly KubeResource[];
  /** Kinds (and namespaces) to watch: the source, intermediate and target kinds. */
  readonly demands: readonly KindDemand[];
  readonly pending: boolean;
  /** The source kind is loaded but the source no longer exists. */
  readonly sourceMissing: boolean;
}

export const EMPTY_SCOPE_RESOLUTION: ScopeResolution = {
  uids: new Set(),
  found: [],
  demands: [],
  pending: false,
  sourceMissing: false,
};

export function scopeSourceOf(r: KubeResource): ScopeSource {
  return { group: r.kind.group, kind: r.kind.kind, namespace: r.namespace, name: r.name, uid: r.uid };
}

/** Resources in scope: descendants through `children` (related) or ancestors through `index` (parents), cycle-safe. */
export function resolveScope(
  scope: ViewScope,
  lookup: ResourceLookup,
  index: ParentIndex,
  allNamespaces: boolean,
): ScopeResolution {
  const s = scope.source;
  const demands: KindDemand[] = [{ group: s.group, kind: s.kind, namespace: s.namespace }];
  const list = lookup.list(s.group, s.kind, s.namespace);
  const source = list?.find((r) => r.uid === s.uid);
  if (!source) {
    return { uids: new Set(), found: [], demands, pending: list === undefined, sourceMissing: list !== undefined };
  }
  const found = new Map<string, KubeResource>();
  let pending = false;
  const addDemands = (ds: readonly KindDemand[]) => {
    for (const d of ds) {
      if (!demands.some((x) => x.group === d.group && x.kind === d.kind && x.namespace === d.namespace))
        demands.push(d);
    }
  };
  const visit = (r: KubeResource): boolean => {
    if (r.uid === source.uid || found.has(r.uid)) return false;
    found.set(r.uid, r);
    return true;
  };
  if (scope.direction === "related") {
    const queue: [KubeResource, readonly ChildDefinition[]][] = [[source, scope.children]];
    while (queue.length > 0) {
      const [parent, defs] = queue.shift()!;
      for (const def of defs) {
        if (def.hidden) continue;
        const res = def.relation.resolve(parent, lookup);
        addDemands(res.demands);
        pending ||= res.pending;
        for (const item of res.items) {
          if (item.type === "resource" && def.accepts(item.resource) && visit(item.resource)) {
            queue.push([item.resource, def.children]);
          }
        }
      }
    }
  } else {
    const queue: KubeResource[] = [source];
    while (queue.length > 0) {
      const res = index.parents(queue.shift()!, lookup, allNamespaces);
      addDemands(res.demands);
      pending ||= res.pending;
      for (const hit of res.items) if (visit(hit.resource)) queue.push(hit.resource);
    }
  }
  return { uids: new Set(found.keys()), found: [...found.values()], demands, pending, sourceMissing: false };
}
