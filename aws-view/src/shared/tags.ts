/** Shared by the extension and the tag editor webview: no `vscode` or Node imports. */
export interface TagRow {
  readonly key: string;
  readonly value: string;
}

export const MAX_TAGS = 50;

/** `aws:` tags belong to AWS (CloudFormation, Auto Scaling…): read-only, never shown in the editor. */
export function isAwsTag(key: string): boolean {
  return key.toLowerCase().startsWith("aws:");
}

export function editableRows(tags: Readonly<Record<string, string>>): TagRow[] {
  return Object.entries(tags)
    .filter(([key]) => !isAwsTag(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
}

export interface TagValidation {
  /** One message (or `undefined`) per row. */
  readonly rows: readonly (string | undefined)[];
  readonly error?: string;
}

/** Keys are trimmed; rows with neither key nor value are ignored. */
export function validateTags(rows: readonly TagRow[]): TagValidation {
  const seen = new Set<string>();
  const errors = rows.map((r) => {
    const key = r.key.trim();
    if (!key && !r.value) return undefined;
    if (!key) return "Key is required";
    if (key.length > 128) return "Key is longer than 128 characters";
    if (isAwsTag(key)) return "Keys starting with aws: are reserved";
    if (r.value.length > 256) return "Value is longer than 256 characters";
    if (seen.has(key)) return "Duplicate key";
    seen.add(key);
    return undefined;
  });
  return seen.size > MAX_TAGS
    ? { rows: errors, error: `An instance can have at most ${MAX_TAGS} tags.` }
    : { rows: errors };
}

export interface TagDiff {
  readonly toCreate: Readonly<Record<string, string>>;
  readonly toDelete: readonly string[];
}

export function diffTags(before: Readonly<Record<string, string>>, rows: readonly TagRow[]): TagDiff {
  const after = new Map(
    rows.filter((r) => r.key.trim() && !isAwsTag(r.key.trim())).map((r) => [r.key.trim(), r.value] as const),
  );
  const toCreate = Object.fromEntries(
    [...after].filter(([key, value]) => !Object.hasOwn(before, key) || before[key] !== value),
  );
  const toDelete = Object.keys(before).filter((key) => !isAwsTag(key) && !after.has(key));
  return { toCreate, toDelete };
}
