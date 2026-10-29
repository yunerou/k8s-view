/**
 * Client-side annotation filter (the API server cannot filter annotations): `key`, `key=value`, or `key!=value`,
 * with comma-separated conditions (AND).
 */
export type AnnotationCondition =
  | { readonly key: string; readonly op: "exists" }
  | { readonly key: string; readonly op: "eq" | "neq"; readonly value: string };

export function parseAnnotationFilter(text: string): AnnotationCondition[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): AnnotationCondition => {
      const neq = part.indexOf("!=");
      if (neq > 0) return { key: part.slice(0, neq).trim(), op: "neq", value: part.slice(neq + 2).trim() };
      const eq = part.indexOf("=");
      if (eq > 0) return { key: part.slice(0, eq).trim(), op: "eq", value: part.slice(eq + 1).trim() };
      return { key: part, op: "exists" };
    });
}

export function matchesAnnotations(
  annotations: Readonly<Record<string, string>>,
  conditions: readonly AnnotationCondition[],
): boolean {
  return conditions.every((c) => {
    const v = annotations[c.key];
    if (c.op === "exists") return v !== undefined;
    if (c.op === "eq") return v === c.value;
    return v !== c.value;
  });
}
