import type { FilterConfig } from "../config/schema";
import type { CompiledPath, ExpressionEngine } from "../expression/ExpressionEngine";
import type { KubeResource } from "../resource/KubeResource";

interface Condition {
  readonly cfg: FilterConfig;
  readonly path: CompiledPath | undefined;
  readonly regex: RegExp | undefined;
}

/** AND conditions, evaluated against raw resource objects. */
export class CompiledFilter {
  private readonly conditions: Condition[];

  constructor(config: FilterConfig | readonly FilterConfig[], engine: ExpressionEngine) {
    const list = Array.isArray(config) ? config : [config as FilterConfig];
    this.conditions = list.map((cfg) => ({
      cfg,
      path: cfg.path === undefined ? undefined : engine.compilePath(cfg.path),
      regex: cfg.op === "regex" ? new RegExp(String(cfg.value ?? "")) : undefined,
    }));
  }

  test(resource: KubeResource): boolean {
    return this.conditions.every((c) => evaluate(c, resource));
  }
}

function evaluate({ cfg, path, regex }: Condition, resource: KubeResource): boolean {
  switch (cfg.op) {
    case "ownedBy":
      return ownedBy(resource, String(cfg.value));
    case "notOwnedBy":
      return !ownedBy(resource, String(cfg.value));
    default:
      break;
  }
  const values = (path?.all(resource.object) ?? []).filter((v) => v !== undefined && v !== null);
  switch (cfg.op) {
    case "eq":
      return values.some((v) => same(v, cfg.value));
    case "neq":
      return !values.some((v) => same(v, cfg.value));
    case "in": {
      const options = Array.isArray(cfg.value) ? cfg.value : [cfg.value];
      return values.some((v) => options.some((o) => same(v, o)));
    }
    case "exists":
      return values.length > 0;
    case "notExists":
      return values.length === 0;
    case "regex":
      return values.some((v) => regex!.test(typeof v === "string" ? v : JSON.stringify(v)));
  }
}

function same(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "object" || typeof expected === "object")
    return JSON.stringify(actual) === JSON.stringify(expected);
  return String(actual) === String(expected);
}

/** `value` is `Kind` or `group/Kind`. */
function ownedBy(resource: KubeResource, value: string): boolean {
  const slash = value.lastIndexOf("/");
  const kind = slash < 0 ? value : value.slice(slash + 1);
  const group = slash < 0 ? undefined : value.slice(0, slash);
  return resource.owners.some((o) => {
    if (o.kind !== kind) return false;
    if (group === undefined) return true;
    const ownerGroup = o.apiVersion.includes("/") ? o.apiVersion.slice(0, o.apiVersion.lastIndexOf("/")) : "";
    return ownerGroup === group;
  });
}
