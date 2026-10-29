import { JSONPath } from "jsonpath-plus";
import { applyModifiers, parseTemplate, type TemplatePart, TemplateSyntaxError } from "./Template";

/** `"safe"`: `[?()]` filters use jsonpath-plus's safe evaluator; `false`: filters are forbidden (untrusted workspace). */
export type EvalMode = "safe" | false;

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = "ExpressionError";
  }
}

const MULTI = /\[\s*\*\s*\]|\[\s*\?|\.\.|\[[^\]]*,[^\]]*\]|\.\*/;

export class CompiledPath {
  /** Paths with wildcards/filters/unions: results are lists rather than single values. */
  readonly isMulti: boolean;

  constructor(
    readonly source: string,
    private readonly evalMode: EvalMode,
  ) {
    this.isMulti = MULTI.test(source);
  }

  all(json: unknown): unknown[] {
    if (json === null || typeof json !== "object") return [];
    const result = JSONPath({ path: this.source, json: json as object, wrap: true, eval: this.evalMode });
    return Array.isArray(result) ? result : [];
  }

  first(json: unknown): unknown {
    return this.all(json)[0];
  }

  /** Count: multiple results → result count; single value → array length / key count / the number itself. */
  count(json: unknown): number {
    const values = this.all(json).filter((v) => v !== undefined && v !== null);
    if (this.isMulti) return values.length;
    const v = values[0];
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === "object") return Object.keys(v).length;
    if (typeof v === "number") return v;
    return values.length;
  }
}

export interface TemplateContext {
  /** Object referenced by `$`. */
  readonly root: unknown;
  variable(name: string, arg?: string): string | undefined;
}

export class CompiledTemplate {
  constructor(
    readonly source: string,
    private readonly parts: readonly (TemplatePart | { type: "path"; compiled: CompiledPath; part: TemplatePart })[],
  ) {}

  get isConstant(): boolean {
    return this.parts.every((p) => p.type === "literal");
  }

  render(ctx: TemplateContext): string {
    let out = "";
    for (const p of this.parts) {
      if (p.type === "literal") out += p.text;
      else if (p.type === "path") {
        const part = p.part as Extract<TemplatePart, { type: "expr" }>;
        out += applyModifiers(pathValue(p.compiled, ctx.root, part.modifiers), part.modifiers);
      } else if (p.kind === "variable") {
        out += applyModifiers(ctx.variable(p.name, p.arg) ?? "", p.modifiers);
      }
    }
    return out;
  }
}

export interface TemplateOptions {
  /** Valid variable names (excluding prefixes such as `label:`); omitted = no validation. */
  readonly variables?: readonly string[];
}

export class ExpressionEngine {
  private readonly paths = new Map<string, CompiledPath>();

  constructor(readonly evalMode: EvalMode) {}

  compilePath(path: string): CompiledPath {
    const cached = this.paths.get(path);
    if (cached) return cached;
    const trimmed = path.trim();
    if (!trimmed.startsWith("$")) throw new ExpressionError(`JSONPath must start with '$': ${path}`, path);
    if (this.evalMode === false && /\[\s*\??\(/.test(trimmed)) {
      throw new ExpressionError(`JSONPath filter expressions are disabled in untrusted workspaces: ${path}`, path);
    }
    try {
      JSONPath.toPathArray(trimmed);
      JSONPath({ path: trimmed, json: {}, wrap: true, eval: this.evalMode });
    } catch (e) {
      throw new ExpressionError(`Invalid JSONPath '${path}': ${(e as Error).message}`, path);
    }
    const compiled = new CompiledPath(trimmed, this.evalMode);
    this.paths.set(path, compiled);
    return compiled;
  }

  compileTemplate(template: string, options: TemplateOptions = {}): CompiledTemplate {
    let parts: TemplatePart[];
    try {
      parts = parseTemplate(template);
    } catch (e) {
      if (e instanceof TemplateSyntaxError) throw new ExpressionError(e.message, template);
      throw e;
    }
    const compiled = parts.map((p) => {
      if (p.type === "expr" && p.kind === "path")
        return { type: "path" as const, compiled: this.compilePath(p.path), part: p };
      if (p.type === "expr" && options.variables && !options.variables.includes(p.name)) {
        throw new ExpressionError(`Unknown variable '${p.name}' in template '${template}'`, template);
      }
      return p;
    });
    return new CompiledTemplate(template, compiled);
  }
}

function pathValue(path: CompiledPath, root: unknown, modifiers: readonly { name: string }[]): string {
  const reducer = modifiers.find((m) => m.name === "count" || m.name === "sum");
  if (reducer?.name === "count") return String(path.count(root));
  const values = path.all(root);
  if (reducer?.name === "sum") {
    const flat = values
      .flat()
      .filter((v) => typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))));
    return String(flat.reduce((acc: number, v) => acc + Number(v), 0));
  }
  return stringify(values);
}

export function stringify(values: unknown): string {
  if (values === undefined || values === null) return "";
  if (Array.isArray(values)) {
    return values
      .filter((v) => v !== undefined && v !== null)
      .map((v) => stringify(v))
      .join(",");
  }
  if (typeof values === "object") return JSON.stringify(values);
  return String(values);
}
