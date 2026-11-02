import { inject, injectable } from "@needle-di/core";
import type * as vscode from "vscode";
import type { SectionConfig } from "../core/config/schema";
import { kindViewConfig } from "../core/view/kindView";
import { edgeChildKind } from "../core/view/ParentIndex";
import type { KindKey } from "../core/view/RelationResolver";
import { resolveScope, type ScopeDirection, type ScopeSource, type ViewScope } from "../core/view/ScopeResolver";
import { scopedViewConfig, scopedViewId } from "../core/view/scopedView";
import type { ChildDefinition, SectionDefinition } from "../core/view/ViewDefinition";
import { ContextService } from "./ContextService";
import { ResourceSource } from "./ports/ResourceSource";
import { ViewRegistry } from "./ViewRegistry";

/** Open Related / Open Parent: register a dynamic view per source and direction, limited to the source's relations. */
@injectable()
export class ScopedViewService implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private contextName: string | undefined;

  constructor(
    private readonly views = inject(ViewRegistry),
    private readonly contexts = inject(ContextService),
    private readonly source = inject(ResourceSource),
  ) {
    // Scopes point at resources of one context; namespace changes keep them.
    this.contextName = contexts.current?.name;
    this.subscription = contexts.onDidChange((ctx) => {
      if (ctx?.name === this.contextName) return;
      this.contextName = ctx?.name;
      this.clear();
    });
  }

  /**
   * Register the scoped view (or keep the existing one) and return its ID; `undefined` when the kind has nothing to
   * show. `children`: the source section's children when known (opened from a table), else the first section listing
   * the kind with children.
   */
  ensure(direction: ScopeDirection, source: ScopeSource, children?: readonly ChildDefinition[]): string | undefined {
    const id = scopedViewId(direction, source.uid);
    if (this.views.get(id)?.scope) return id;
    const ctx = this.contexts.current;
    if (!ctx) return undefined;
    const scope: ViewScope = {
      direction,
      source,
      context: ctx.name,
      children: direction === "related" ? (children ?? this.sourceSection(source)?.children ?? []) : [],
    };
    const kinds = this.kinds(scope);
    if (kinds.length === 0) return undefined;
    this.views.setDynamic(
      scopedViewConfig(
        id,
        scope,
        kinds.map((k) => this.template(k)),
      ),
      scope,
    );
    return id;
  }

  remove(viewId: string): void {
    if (this.views.get(viewId)?.scope) this.views.removeDynamic(viewId);
  }

  clear(): void {
    for (const v of this.views.scopedViews()) this.views.removeDynamic(v.id);
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private sourceSection(source: ScopeSource): SectionDefinition | undefined {
    return this.views
      .allViews()
      .flatMap((v) => v.definition.sections)
      .find(
        (s) =>
          s.resources.some((r) => r.group === source.group && r.kind === source.kind) &&
          s.children.some((c) => !c.hidden),
      );
  }

  /** Related: kinds of the children tree. Parents: ancestor kinds found now (static ones while kinds still load). */
  private kinds(scope: ViewScope): KindKey[] {
    const s = scope.source;
    const out = new Map<string, KindKey>();
    const add = (k: KindKey) => {
      const key = `${k.group}/${k.kind}`;
      if (!out.has(key) && !(k.group === s.group && k.kind === s.kind)) out.set(key, { group: k.group, kind: k.kind });
    };
    const ctx = this.contexts.current;
    const index = this.views.parentIndex;
    const resolved = ctx ? resolveScope(scope, this.source.lookup(ctx), index, ctx.scope.type === "all") : undefined;
    if (scope.direction === "related") {
      const visit = (defs: readonly ChildDefinition[]) => {
        for (const d of defs) {
          if (d.hidden) continue;
          const k = edgeChildKind(d.relation);
          if (k) add(k);
          visit(d.children);
        }
      };
      visit(scope.children);
    } else if (!resolved || resolved.pending) {
      for (const k of index.ancestorKinds(s)) add(k);
    }
    for (const r of resolved?.found ?? []) add(r.kind);
    return [...out.values()];
  }

  /** First single-kind section (by view order) for `k`, else the generic kind view section. */
  private template(k: KindKey): SectionConfig {
    for (const v of this.views.allViews()) {
      for (const s of v.definition.config.sections) {
        const only = s.resources.length === 1 ? s.resources[0] : undefined;
        if (only && only.group === k.group && only.kind === k.kind) return s;
      }
    }
    return kindViewConfig({ group: k.group, kind: k.kind }).sections[0]!;
  }
}
