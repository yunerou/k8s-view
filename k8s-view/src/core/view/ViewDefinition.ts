import type { ChildConfig, FilterConfig, ResourceRef, SectionConfig, StatusConfig, ViewConfig } from "../config/schema";
import {
  type CompiledPath,
  type CompiledTemplate,
  type ExpressionEngine,
  ExpressionError,
  stringify,
} from "../expression/ExpressionEngine";
import { RESOURCE_VARIABLES, resourceContext } from "../expression/variables";
import { formatAge } from "../resource/format";
import type { KubeResource } from "../resource/KubeResource";
import { ColumnDefinition } from "./Column";
import { CompiledFilter } from "./Filter";
import { childId } from "./merge";
import { CompiledRelation } from "./RelationResolver";
import { StatusEvaluator, type StatusResult } from "./StatusEvaluator";

export type ConfigPath = (string | number)[];

export interface CompileIssue {
  /** Relative path within the view object (e.g. `["sections", 0, "columns", 1, "path"]`). */
  readonly path: ConfigPath;
  readonly message: string;
}

export interface SortSpec {
  readonly by: string;
  readonly order: "asc" | "desc";
}

/** Shared section/child fields: filters, status, description, children. */
abstract class NodeDefinition {
  constructor(
    readonly filter: CompiledFilter | undefined,
    private readonly statusConfig: StatusConfig | undefined,
    private readonly labelTemplate: CompiledTemplate | undefined,
    private readonly descriptionTemplate: CompiledTemplate | undefined,
    readonly children: readonly ChildDefinition[],
    private readonly statusEvaluator: StatusEvaluator,
  ) {}

  accepts(r: KubeResource): boolean {
    return this.filter?.test(r) ?? true;
  }

  status(r: KubeResource): StatusResult {
    return this.statusEvaluator.evaluate(r, this.statusConfig);
  }

  /** Tree label: `label` template (e.g. related object for Events), defaulting to the resource name. */
  label(r: KubeResource): string {
    return this.labelTemplate?.render(resourceContext(r)) || r.name;
  }

  /** Tree description: view template, or `<status summary> · <age>` by default. */
  describe(r: KubeResource, now: number): string {
    if (this.descriptionTemplate) return this.descriptionTemplate.render(resourceContext(r));
    const age = r.ageMs(now);
    return [this.status(r).summary, age === undefined ? undefined : formatAge(age)].filter(Boolean).join(" · ");
  }
}

export class ChildDefinition extends NodeDefinition {
  constructor(
    readonly id: string,
    readonly title: string | undefined,
    readonly relation: CompiledRelation,
    readonly hidden: boolean,
    filter: CompiledFilter | undefined,
    statusConfig: StatusConfig | undefined,
    label: CompiledTemplate | undefined,
    description: CompiledTemplate | undefined,
    children: readonly ChildDefinition[],
    statusEvaluator: StatusEvaluator,
  ) {
    super(filter, statusConfig, label, description, children, statusEvaluator);
  }
}

export class SectionDefinition extends NodeDefinition {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly icon: string | undefined,
    readonly resources: readonly ResourceRef[],
    readonly columns: readonly ColumnDefinition[],
    readonly groupBy: string | undefined,
    private readonly groupPath: CompiledPath | undefined,
    readonly sort: SortSpec | undefined,
    readonly sortPath: CompiledPath | undefined,
    /** Always list all namespaces (e.g. cluster-wide Events), regardless of the selected namespace. */
    readonly allNamespaces: boolean,
    readonly hidden: boolean,
    filter: CompiledFilter | undefined,
    statusConfig: StatusConfig | undefined,
    label: CompiledTemplate | undefined,
    description: CompiledTemplate | undefined,
    children: readonly ChildDefinition[],
    statusEvaluator: StatusEvaluator,
  ) {
    super(filter, statusConfig, label, description, children, statusEvaluator);
  }

  /** Group key based on `groupBy`: kind, namespace, status, label:<key>, or JSONPath. */
  groupKey(r: KubeResource): string | undefined {
    const g = this.groupBy;
    if (!g) return undefined;
    if (g === "kind") return r.kind.kind;
    if (g === "namespace") return r.namespace ?? "(cluster)";
    if (g === "status") return this.status(r).level;
    if (g.startsWith("label:")) return r.labels[g.slice(6)] ?? "(none)";
    return stringify(this.groupPath?.first(r.object)) || "(none)";
  }
}

export class ViewDefinition {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly icon: string | undefined,
    readonly requires: readonly string[],
    readonly enabled: boolean,
    readonly order: number | undefined,
    /** Show active port forwards at the top of the view (Service view). */
    readonly portForwards: boolean,
    readonly sections: readonly SectionDefinition[],
    /** Original config (after merging), used for "Edit view config" and "Save to config". */
    readonly config: ViewConfig,
  ) {}

  /** All kinds the view may need (sections + children with fixed kinds). */
  get kinds(): { group: string; kind: string }[] {
    const out = new Map<string, { group: string; kind: string }>();
    const visit = (children: readonly ChildDefinition[]) => {
      for (const c of children) {
        const k = c.relation.childKind;
        if (k) out.set(`${k.group}/${k.kind}`, k);
        visit(c.children);
      }
    };
    for (const s of this.sections) {
      for (const r of s.resources) out.set(`${r.group}/${r.kind}`, { group: r.group, kind: r.kind });
      visit(s.children);
    }
    return [...out.values()];
  }
}

/** Compile a merged view into an immutable definition. Invalid parts are skipped and reported as issues; the rest still works. */
export function compileView(
  config: ViewConfig,
  engine: ExpressionEngine,
): { view: ViewDefinition; issues: CompileIssue[] } {
  const issues: CompileIssue[] = [];
  const statusEvaluator = new StatusEvaluator(engine);
  const attempt = <T>(path: ConfigPath, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ExpressionError || e instanceof SyntaxError) {
        issues.push({ path, message: e.message });
        return undefined;
      }
      throw e;
    }
  };
  const filterOf = (f: FilterConfig | FilterConfig[] | undefined, path: ConfigPath) =>
    f === undefined ? undefined : attempt(path, () => new CompiledFilter(f, engine));
  const statusOf = (s: StatusConfig | undefined, path: ConfigPath) =>
    attempt(path, () => {
      statusEvaluator.compile(s);
      return s;
    });
  const templateOf = (d: string | undefined, path: ConfigPath) =>
    d === undefined ? undefined : attempt(path, () => engine.compileTemplate(d, { variables: RESOURCE_VARIABLES }));

  const compileChildren = (children: readonly ChildConfig[], base: ConfigPath): ChildDefinition[] =>
    children.flatMap((c, i) => {
      const path = [...base, i];
      const relation = attempt([...path, "relation"], () => new CompiledRelation(c.relation, engine));
      if (!relation) return [];
      return [
        new ChildDefinition(
          childId(c as unknown as Record<string, unknown>) ?? `child-${i}`,
          c.title,
          relation,
          c.hidden,
          filterOf(c.filter, [...path, "filter"]),
          statusOf(c.status, [...path, "status"]),
          templateOf(c.label, [...path, "label"]),
          templateOf(c.description, [...path, "description"]),
          compileChildren(c.children, [...path, "children"]),
          statusEvaluator,
        ),
      ];
    });

  const sections = config.sections.map((s: SectionConfig, i) => {
    const path: ConfigPath = ["sections", i];
    const columns = s.columns.flatMap((c, j) => {
      const col = attempt(
        [...path, "columns", j, "path" in c ? "path" : "template"],
        () => new ColumnDefinition(c, engine),
      );
      return col ? [col] : [];
    });
    const sort: SortSpec | undefined =
      s.sort === undefined ? undefined : typeof s.sort === "string" ? { by: s.sort, order: "asc" } : s.sort;
    const groupPath =
      s.groupBy?.startsWith("$") === true
        ? attempt([...path, "groupBy"], () => engine.compilePath(s.groupBy!))
        : undefined;
    const sortPath = sort?.by.startsWith("$")
      ? attempt([...path, "sort"], () => engine.compilePath(sort.by))
      : undefined;
    return new SectionDefinition(
      s.id,
      s.title,
      s.icon,
      s.resources,
      columns,
      s.groupBy,
      groupPath,
      sort,
      sortPath,
      s.allNamespaces,
      s.hidden,
      filterOf(s.filter, [...path, "filter"]),
      statusOf(s.status, [...path, "status"]),
      templateOf(s.label, [...path, "label"]),
      templateOf(s.description, [...path, "description"]),
      compileChildren(s.children, [...path, "children"]),
      statusEvaluator,
    );
  });

  const view = new ViewDefinition(
    config.id,
    config.title,
    config.icon,
    config.requires ?? [],
    config.enabled,
    config.order,
    config.portForwards,
    sections,
    config,
  );
  return { view, issues };
}
