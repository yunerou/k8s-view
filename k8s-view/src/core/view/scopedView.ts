import { type SectionConfig, type ViewConfig, ViewSchema } from "../config/schema";
import type { KindKey } from "./RelationResolver";
import type { ScopeDirection, ViewScope } from "./ScopeResolver";

const PREFIX = /^(related|parents)\./;

/** View IDs allow only `[A-Za-z0-9._-]`. */
export function scopedViewId(direction: ScopeDirection, uid: string): string {
  return `${direction}.${uid}`;
}

export function scopedDirection(viewId: string): ScopeDirection | undefined {
  return PREFIX.exec(viewId)?.[1] as ScopeDirection | undefined;
}

export function scopedSectionId(k: KindKey): string {
  return `${k.kind}${k.group ? `.${k.group}` : ""}`.toLowerCase();
}

/** One section per kind, copied from `templates` without filters or grouping (the scope decides the rows). */
export function scopedViewConfig(id: string, scope: ViewScope, templates: readonly SectionConfig[]): ViewConfig {
  const s = scope.source;
  const label = `${s.kind} ${s.namespace ? `${s.namespace}/` : ""}${s.name}`;
  return ViewSchema.parse({
    id,
    title: `${scope.direction === "related" ? "Related" : "Parents"} · ${label}`,
    icon: scope.direction === "related" ? "references" : "arrow-up",
    order: 1000,
    sections: templates.map((t) => {
      const r = t.resources[0]!;
      const { id: _id, filter: _filter, groupBy: _groupBy, hidden: _hidden, allNamespaces: _all, ...rest } = t;
      return { ...rest, id: scopedSectionId(r), resources: [{ group: r.group, kind: r.kind }] };
    }),
  });
}
