import type { RelationConfig } from "../config/schema";
import type { CompiledPath, CompiledTemplate, ExpressionEngine } from "../expression/ExpressionEngine";
import { FIELD_VARIABLES, RESOURCE_VARIABLES, resourceVariable } from "../expression/variables";
import type { KubeResource } from "../resource/KubeResource";
import { ResourceKind } from "../resource/ResourceKind";
import { matchesSelector } from "./labelSelector";

/** Look up loaded resources. `undefined` = kind not yet loaded (not acquired or still listing). */
export interface ResourceLookup {
  /** Undefined `namespace` = all namespaces currently in the store; cluster-scoped kinds ignore namespace. */
  list(group: string, kind: string, namespace: string | undefined): readonly KubeResource[] | undefined;
  byOwner(group: string, kind: string, ownerUid: string): readonly KubeResource[] | undefined;
}

/** Kind (and namespace) that must be watched to resolve a relation. */
export interface KindDemand {
  readonly group: string;
  readonly kind: string;
  readonly namespace: string | undefined;
}

export type ChildItem =
  | { readonly type: "resource"; readonly resource: KubeResource }
  | {
      readonly type: "missing";
      readonly group: string;
      readonly kind: string;
      readonly name: string;
      readonly namespace: string | undefined;
    }
  | {
      readonly type: "field";
      readonly parent: KubeResource;
      readonly index: number;
      readonly key: string | undefined;
      readonly value: unknown;
      readonly label: string;
      readonly description: string | undefined;
      readonly icon: string | undefined;
    };

export interface Resolution {
  readonly items: ChildItem[];
  readonly demands: KindDemand[];
  /** A required kind has not finished loading: show "Loading…". */
  readonly pending: boolean;
}

const CORE_VERSION = /^v\d+((alpha|beta)\d+)?$/;
const FIELD_TEMPLATE_VARS = [...RESOURCE_VARIABLES, ...FIELD_VARIABLES];

/** Compiled relation: find children by ownerRef, label selector, references, reverse references, or nested arrays. */
export class CompiledRelation {
  private readonly items: CompiledPath | undefined;
  private readonly selector: CompiledPath | undefined;
  private readonly refGroup: CompiledPath | undefined;
  private readonly refKind: CompiledPath | undefined;
  private readonly refName: CompiledPath | undefined;
  private readonly refNamespace: CompiledPath | undefined;
  private readonly matchName: CompiledTemplate | undefined;
  private readonly matchNamespace: CompiledTemplate | undefined;
  private readonly label: CompiledTemplate | undefined;
  private readonly description: CompiledTemplate | undefined;

  constructor(
    readonly config: RelationConfig,
    engine: ExpressionEngine,
  ) {
    const c = config;
    this.items = "items" in c ? engine.compilePath(c.items) : undefined;
    this.selector = c.type === "labelSelector" ? engine.compilePath(c.selector) : undefined;
    if (c.type === "fieldRef") {
      this.refGroup = c.group.path ? engine.compilePath(c.group.path) : undefined;
      this.refKind = c.kind.path ? engine.compilePath(c.kind.path) : undefined;
      this.refName = engine.compilePath(c.name);
      this.refNamespace = c.namespace === "$self" ? undefined : engine.compilePath(c.namespace);
    }
    if (c.type === "reverseFieldRef") {
      this.matchName = engine.compileTemplate(c.match.name, { variables: RESOURCE_VARIABLES });
      this.matchNamespace =
        c.match.namespace === undefined
          ? undefined
          : engine.compileTemplate(c.match.namespace, { variables: RESOURCE_VARIABLES });
    }
    if (c.type === "field") {
      this.label = engine.compileTemplate(c.label, { variables: FIELD_TEMPLATE_VARS });
      this.description =
        c.description === undefined
          ? undefined
          : engine.compileTemplate(c.description, { variables: FIELD_TEMPLATE_VARS });
    }
  }

  /** Fixed child kind (absent for dynamic fieldRef and field relations). */
  get childKind(): { group: string; kind: string } | undefined {
    const c = this.config;
    return c.type === "ownerRef" || c.type === "labelSelector" || c.type === "reverseFieldRef"
      ? { group: c.group, kind: c.kind }
      : undefined;
  }

  resolve(parent: KubeResource, lookup: ResourceLookup): Resolution {
    const c = this.config;
    switch (c.type) {
      case "ownerRef": {
        const demand = { group: c.group, kind: c.kind, namespace: parent.namespace };
        const found = lookup.byOwner(c.group, c.kind, parent.uid);
        return toResolution(found, [demand]);
      }
      case "labelSelector": {
        const demand = { group: c.group, kind: c.kind, namespace: parent.namespace };
        const selector = this.selector!.first(parent.object);
        const candidates = lookup.list(c.group, c.kind, parent.namespace);
        return toResolution(
          candidates?.filter((r) => matchesSelector(selector, r.labels)),
          [demand],
        );
      }
      case "reverseFieldRef":
        return this.resolveReverse(c, parent, lookup);
      case "fieldRef":
        return this.resolveFieldRef(c, parent, lookup);
      case "field":
        return this.resolveField(c, parent);
    }
  }

  private resolveReverse(
    c: Extract<RelationConfig, { type: "reverseFieldRef" }>,
    parent: KubeResource,
    lookup: ResourceLookup,
  ): Resolution {
    const namespace = c.allNamespaces ? undefined : parent.namespace;
    const ctx = { root: parent.object, variable: (n: string, a?: string) => resourceVariable(parent, n, a) };
    const name = this.matchName!.render(ctx);
    const ns = this.matchNamespace?.render(ctx);
    const candidates = lookup.list(c.group, c.kind, namespace);
    const found = candidates?.filter((child) =>
      this.items!.all(child.object).some((ref) => {
        // String entry = parent name (e.g. Pod `$.spec.nodeName` → Node).
        if (typeof ref === "string") return ref === name && ns === undefined;
        if (!ref || typeof ref !== "object") return false;
        const r = ref as { name?: unknown; namespace?: unknown };
        if (r.name !== name) return false;
        return ns === undefined || (r.namespace ?? child.namespace) === ns;
      }),
    );
    return toResolution(found, [{ group: c.group, kind: c.kind, namespace }]);
  }

  private resolveFieldRef(
    c: Extract<RelationConfig, { type: "fieldRef" }>,
    parent: KubeResource,
    lookup: ResourceLookup,
  ): Resolution {
    const items: ChildItem[] = [];
    const demands: KindDemand[] = [];
    let pending = false;
    for (const ref of this.items!.all(parent.object)) {
      if (!ref || typeof ref !== "object") continue;
      const group = toGroup(this.refGroup?.first(ref), c.group.default);
      const kind = asString(this.refKind?.first(ref)) ?? c.kind.default;
      const name = asString(this.refName!.first(ref));
      if (!name) continue;
      const namespace = asString(this.refNamespace?.first(ref)) ?? parent.namespace;
      if (!demands.some((d) => d.group === group && d.kind === kind && d.namespace === namespace))
        demands.push({ group, kind, namespace });
      const candidates = lookup.list(group, kind, namespace);
      if (!candidates) {
        pending = true;
        continue;
      }
      const target = candidates.find((r) => r.name === name && (!r.kind.namespaced || r.namespace === namespace));
      items.push(target ? { type: "resource", resource: target } : { type: "missing", group, kind, name, namespace });
    }
    return { items, demands, pending };
  }

  private resolveField(c: Extract<RelationConfig, { type: "field" }>, parent: KubeResource): Resolution {
    const values = this.items!.all(parent.object);
    let entries: { key: string | undefined; value: unknown }[];
    const only = values.length === 1 ? values[0] : undefined;
    if (Array.isArray(only)) entries = only.map((value) => ({ key: undefined, value }));
    else if (only && typeof only === "object" && !/\[\*\]\s*$/.test(c.items)) {
      entries = Object.entries(only).map(([key, value]) => ({ key, value }));
    } else entries = values.map((value) => ({ key: undefined, value }));

    const items = entries.map(({ key, value }, index): ChildItem => {
      const root = key === undefined ? value : { key, value };
      const ctx = {
        root,
        variable: (n: string, a?: string) =>
          n === "key" ? key : n === "index" ? String(index) : resourceVariable(parent, n, a),
      };
      return {
        type: "field",
        parent,
        index,
        key,
        value,
        label: this.label!.render(ctx) || (key ?? String(index)),
        description: this.description?.render(ctx),
        icon: c.icon,
      };
    });
    return { items, demands: [], pending: false };
  }
}

function toResolution(found: readonly KubeResource[] | undefined, demands: KindDemand[]): Resolution {
  return {
    items: (found ?? []).map((resource) => ({ type: "resource", resource })),
    demands,
    pending: found === undefined,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Group values may be apiVersion (`source.toolkit.fluxcd.io/v1`, `v1`) or group names. */
function toGroup(v: unknown, fallback: string): string {
  const s = asString(v);
  if (s === undefined) return fallback;
  if (s.includes("/")) return ResourceKind.splitApiVersion(s).group;
  return CORE_VERSION.test(s) ? "" : s;
}
