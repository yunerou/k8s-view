import { INSTANCE_STATES, type Instance, type InstanceState } from "./model";

export interface TagFilter {
  readonly key: string;
  /** Empty: every instance that has the tag. */
  readonly values: readonly string[];
}

export interface InstanceFilter {
  readonly tags: readonly TagFilter[];
  /** Empty: every state except `terminated`. */
  readonly states: readonly InstanceState[];
  readonly nameContains: string;
  readonly pinnedOnly: boolean;
}

/** Same shape as the SDK's EC2 `Filter`. */
export interface Ec2Filter {
  readonly Name: string;
  readonly Values: readonly string[];
}

export function defaultFilter(tags: readonly TagFilter[]): InstanceFilter {
  return { tags, states: [], nameContains: "", pinnedOnly: false };
}

/** Server-side part: tags and states. */
export function ec2Filters(f: InstanceFilter): Ec2Filter[] {
  const states = f.states.length > 0 ? f.states : INSTANCE_STATES.filter((s) => s !== "terminated");
  return [
    ...f.tags.map((t) =>
      t.values.length > 0 ? { Name: `tag:${t.key}`, Values: [...t.values] } : { Name: "tag-key", Values: [t.key] },
    ),
    { Name: "instance-state-name", Values: [...states] },
  ];
}

/** Client-side part: name/ID substring and pinned only. */
export function matchesClient(i: Instance, f: InstanceFilter, pinned: ReadonlySet<string>): boolean {
  if (f.pinnedOnly && !pinned.has(i.id)) return false;
  const q = f.nameContains.trim().toLowerCase();
  return !q || (i.name ?? "").toLowerCase().includes(q) || i.id.includes(q);
}

export function formatTagFilter(t: TagFilter): string {
  return t.values.length > 0 ? `${t.key}=${t.values.join("|")}` : t.key;
}

/** Short text for the view description; `undefined` when nothing is filtered. */
export function describeFilter(f: InstanceFilter): string | undefined {
  const name = f.nameContains.trim();
  const parts = [
    ...f.tags.map(formatTagFilter),
    ...(f.states.length > 0 ? [f.states.join("|")] : []),
    ...(name ? [`"${name}"`] : []),
    ...(f.pinnedOnly ? ["pinned"] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** `Owner=alice`, `Env=dev|test`, or `Owner` (has the tag). */
export function parseTagFilter(text: string): TagFilter | undefined {
  const m = /^\s*([^=]*?)\s*(?:=(.*))?$/.exec(text);
  const key = m?.[1];
  if (!key) return undefined;
  const values = (m[2] ?? "")
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);
  return { key, values };
}
