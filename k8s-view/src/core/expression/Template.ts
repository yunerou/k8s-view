/** `count`/`sum` transform JSONPath values before stringification; `default` replaces empty strings; others transform strings. */
export interface Modifier {
  readonly name: "lower" | "upper" | "trunc" | "default" | "count" | "sum";
  readonly arg?: number;
  readonly text?: string;
}

export type TemplateExpr =
  | {
      readonly type: "expr";
      readonly source: string;
      readonly kind: "path";
      readonly path: string;
      readonly modifiers: readonly Modifier[];
    }
  | {
      readonly type: "expr";
      readonly source: string;
      readonly kind: "variable";
      readonly name: string;
      readonly arg?: string;
      readonly modifiers: readonly Modifier[];
    };

export type TemplatePart = { readonly type: "literal"; readonly text: string } | TemplateExpr;

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "TemplateSyntaxError";
  }
}

const MODIFIER = /\|(lower|upper|count|sum|trunc:\d+|default:[^|]*)$/;

/**
 * Split `a ${expr} b` into literals + expressions. Count `{}` braces and skip characters inside '…'/"…" strings,
 * so `}` inside JSONPath filters does not break expressions.
 */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let literal = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "$" && template[i + 1] === "{") {
      const start = i;
      let depth = 1;
      let quote: string | undefined;
      let j = i + 2;
      for (; j < template.length; j++) {
        const ch = template[j];
        if (quote) {
          if (ch === "\\") j++;
          else if (ch === quote) quote = undefined;
        } else if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) break;
      }
      if (depth !== 0) throw new TemplateSyntaxError(`Unterminated expression starting at offset ${start}`, start);
      if (literal) parts.push({ type: "literal", text: literal });
      literal = "";
      parts.push(parseExpression(template.slice(start + 2, j), start));
      i = j + 1;
    } else {
      literal += template[i];
      i++;
    }
  }
  if (literal) parts.push({ type: "literal", text: literal });
  return parts;
}

function parseExpression(source: string, offset: number): TemplateExpr {
  let body = source.trim();
  const modifiers: Modifier[] = [];
  for (let m = MODIFIER.exec(body); m; m = MODIFIER.exec(body)) {
    const raw = m[1]!;
    modifiers.unshift(
      raw.startsWith("trunc:")
        ? { name: "trunc", arg: Number(raw.slice(6)) }
        : raw.startsWith("default:")
          ? { name: "default", text: raw.slice(8) }
          : { name: raw as "lower" | "upper" | "count" | "sum" },
    );
    body = body.slice(0, m.index).trimEnd();
  }
  if (!body) throw new TemplateSyntaxError(`Empty expression at offset ${offset}`, offset);
  if (body.startsWith("$")) return { type: "expr", source, kind: "path", path: body, modifiers };
  const colon = body.indexOf(":");
  if (colon < 0) return { type: "expr", source, kind: "variable", name: body, modifiers };
  return { type: "expr", source, kind: "variable", name: body.slice(0, colon), arg: body.slice(colon + 1), modifiers };
}

export function applyModifiers(value: string, modifiers: readonly Modifier[]): string {
  let out = value;
  for (const m of modifiers) {
    if (m.name === "lower") out = out.toLowerCase();
    else if (m.name === "upper") out = out.toUpperCase();
    else if (m.name === "trunc") out = out.slice(0, m.arg);
    else if (m.name === "default" && out === "") out = m.text ?? "";
  }
  return out;
}
