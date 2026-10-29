/**
 * Merge view/command overrides (`extends`) onto previously loaded definitions: objects merge by key; object arrays merge by `id`
 * (columns: ID or title slug; children: ID or an ID derived from the relation); entries with `"remove": true` are deleted.
 * Keys with atomic semantics (filter, status, relation, etc.) are replaced in full.
 */

const REPLACE = new Set([
  "filter",
  "status",
  "relation",
  "run",
  "when",
  "resources",
  "match",
  "inputs",
  "sort",
  "requires",
]);

type Json = Record<string, unknown>;

export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "column";
}

export function childId(child: Json): string | undefined {
  if (typeof child["id"] === "string") return child["id"];
  const r = child["relation"] as Json | undefined;
  if (!r) return undefined;
  if (r["type"] === "field") return `field:${String(r["items"])}`;
  if (r["type"] === "fieldRef") return `fieldRef:${String(r["items"])}`;
  return `${String(r["type"])}:${String(r["group"] ?? "")}/${String(r["kind"])}`;
}

function itemId(key: string, item: Json): string | undefined {
  if (key === "columns")
    return typeof item["id"] === "string"
      ? item["id"]
      : typeof item["title"] === "string"
        ? slug(item["title"])
        : undefined;
  if (key === "children") return childId(item);
  return typeof item["id"] === "string" ? item["id"] : undefined;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeArray(key: string, base: unknown[], patch: unknown[]): unknown[] {
  if (!base.every(isObject) || !patch.every(isObject)) return patch;
  const out: Json[] = base.map((b) => ({ ...b }));
  for (const p of patch) {
    const id = itemId(key, p);
    const index = id === undefined ? -1 : out.findIndex((b) => itemId(key, b) === id);
    const { remove, ...rest } = p;
    if (remove === true) {
      if (index >= 0) out.splice(index, 1);
    } else if (index >= 0) {
      out[index] = mergeObject(out[index]!, rest);
    } else {
      out.push(rest);
    }
  }
  return out;
}

function mergeObject(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (REPLACE.has(key) || value === undefined) {
      if (value !== undefined) out[key] = value;
    } else if (Array.isArray(value) && Array.isArray(current)) out[key] = mergeArray(key, current, value);
    else if (isObject(value) && isObject(current)) out[key] = mergeObject(current, value);
    else out[key] = value;
  }
  return out;
}

/** Result is raw data: the caller validates it again with ViewSchema. */
export function applyViewPatch(base: object, patch: object): unknown {
  const { extends: _e, ...rest } = patch as Json;
  return mergeObject(base as Json, rest);
}

export function applyCommandPatch(base: object, patch: object): unknown {
  const { extends: _e, ...rest } = patch as Json;
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
  return out;
}
