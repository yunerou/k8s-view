import type { KubeResource } from "../resource/KubeResource";
import {
  apiGroup,
  type CompiledRelation,
  type KindDemand,
  type KindKey,
  type ResourceLookup,
} from "./RelationResolver";
import type { ChildDefinition, ViewDefinition } from "./ViewDefinition";

export type ParentVia = "owner" | "selects" | "references" | "referencedBy";

export interface ParentHit {
  readonly resource: KubeResource;
  readonly via: readonly ParentVia[];
}

export interface ParentResolution {
  readonly items: readonly ParentHit[];
  readonly demands: readonly KindDemand[];
  /** A parent kind has not finished loading. */
  readonly pending: boolean;
}

interface Edge {
  readonly parent: KindKey;
  readonly child: KindKey;
  /** `undefined` for configured ownerRef relations: owners come from `ownerReferences`; kept for `ancestorKinds`. */
  readonly relation: CompiledRelation | undefined;
  readonly via: ParentVia;
}

const VIA: Record<string, ParentVia> = {
  ownerRef: "owner",
  labelSelector: "selects",
  fieldRef: "references",
  reverseFieldRef: "referencedBy",
};

const same = (a: KindKey, b: KindKey) => a.group === b.group && a.kind === b.kind;
/** Events reference everything through `involvedObject`; they are not structural parents (see the Events tab). */
const isEvent = (k: KindKey) => k.kind === "Event" && (k.group === "" || k.group === "events.k8s.io");

/** Child kind of a relation edge; fieldRef uses its defaults (`inverse` still checks each reference's real kind). */
export function edgeChildKind(relation: CompiledRelation): KindKey | undefined {
  const fixed = relation.childKind;
  if (fixed) return fixed;
  const c = relation.config;
  return c.type === "fieldRef" ? { group: c.group.default, kind: c.kind.default } : undefined;
}

/** Parent relations derived from every view's `children` trees (reversed) plus `ownerReferences`. */
export class ParentIndex {
  static readonly empty = new ParentIndex([]);

  private constructor(private readonly edges: readonly Edge[]) {}

  static build(views: readonly ViewDefinition[]): ParentIndex {
    const edges = new Map<string, Edge>();
    const visit = (parents: readonly KindKey[], children: readonly ChildDefinition[]) => {
      for (const c of children) {
        const child = edgeChildKind(c.relation);
        if (!child) continue;
        const cfg = c.relation.config;
        for (const parent of parents) {
          if (isEvent(parent)) continue;
          const key = `${parent.group}/${parent.kind}|${JSON.stringify(cfg)}`;
          if (!edges.has(key)) {
            edges.set(key, {
              parent,
              child,
              relation: cfg.type === "ownerRef" ? undefined : c.relation,
              via: VIA[cfg.type] ?? "references",
            });
          }
        }
        visit([child], c.children);
      }
    };
    for (const v of views) {
      for (const s of v.sections)
        visit(
          s.resources.map((r) => ({ group: r.group, kind: r.kind })),
          s.children,
        );
    }
    return new ParentIndex([...edges.values()]);
  }

  /** Direct parents of `child`, merged by UID; `allNamespaces` also searches other namespaces for references. */
  parents(child: KubeResource, lookup: ResourceLookup, allNamespaces: boolean): ParentResolution {
    const hits = new Map<string, { resource: KubeResource; via: ParentVia[] }>();
    const demands: KindDemand[] = [];
    let pending = false;
    const add = (r: KubeResource, via: ParentVia) => {
      const hit = hits.get(r.uid);
      if (!hit) hits.set(r.uid, { resource: r, via: [via] });
      else if (!hit.via.includes(via)) hit.via.push(via);
    };
    const demand = (d: KindDemand) => {
      if (!demands.some((x) => x.group === d.group && x.kind === d.kind && x.namespace === d.namespace))
        demands.push(d);
    };
    for (const o of child.owners) {
      const group = apiGroup(o.apiVersion);
      demand({ group, kind: o.kind, namespace: child.namespace });
      const list = lookup.list(group, o.kind, child.namespace);
      if (!list) {
        pending = true;
        continue;
      }
      const owner = list.find((r) => r.uid === o.uid);
      if (owner) add(owner, "owner");
    }
    for (const e of this.edges) {
      if (!e.relation || !same(e.child, child.kind)) continue;
      const res = e.relation.inverse(child, e.parent, lookup, allNamespaces);
      for (const d of res.demands) demand(d);
      pending ||= res.pending;
      for (const i of res.items) if (i.type === "resource" && i.resource.uid !== child.uid) add(i.resource, e.via);
    }
    return { items: [...hits.values()], demands, pending };
  }

  /** Kinds that can be ancestors of `kind` through configured edges (BFS, cycle-safe, without `kind`). */
  ancestorKinds(kind: KindKey): KindKey[] {
    const seen = new Map<string, KindKey>([[`${kind.group}/${kind.kind}`, kind]]);
    const out: KindKey[] = [];
    const queue: KindKey[] = [kind];
    while (queue.length > 0) {
      const k = queue.shift()!;
      for (const e of this.edges) {
        if (!same(e.child, k)) continue;
        const key = `${e.parent.group}/${e.parent.kind}`;
        if (seen.has(key)) continue;
        seen.set(key, e.parent);
        out.push(e.parent);
        queue.push(e.parent);
      }
    }
    return out;
  }

  /** The resource may have parents: it has owners, or a non-owner edge targets its kind. */
  hasParents(r: KubeResource): boolean {
    return r.owners.length > 0 || this.edges.some((e) => e.relation !== undefined && same(e.child, r.kind));
  }
}
