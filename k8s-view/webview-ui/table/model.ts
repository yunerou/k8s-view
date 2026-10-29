import * as l10n from "@vscode/l10n";
import type { SectionPrefs, TablePatch, TableRow, TableSection, TableViewModel } from "../../src/shared/protocol";

/** `groupBy` value that disables grouping (unlike `undefined` = no preference, use the section default). */
export const GROUP_NONE = "none";

/** Apply patches by UID, then reorder by `order`; rows missing from `order` retain their previous order at the end. */
export function applyPatch(model: TableViewModel, patch: TablePatch): TableViewModel {
  const index = model.sections.findIndex((s) => s.id === patch.sectionId);
  const current = model.sections[index];
  if (!current) return model;

  const byUid = new Map(current.rows.map((r) => [r.uid, r]));
  for (const uid of patch.removes) byUid.delete(uid);
  for (const r of patch.upserts) byUid.set(r.uid, r);

  const rows: TableRow[] = [];
  for (const uid of patch.order) {
    const r = byUid.get(uid);
    if (r) {
      rows.push(r);
      byUid.delete(uid);
    }
  }
  rows.push(...byUid.values());

  const sections = [...model.sections];
  sections[index] = { ...current, rows, state: patch.state, problems: patch.problems };
  return { ...model, sections };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compare non-null `TableCell.sort` values: numbers before strings, with natural string ordering. */
export function compareSortValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return collator.compare(a, b);
}

export function effectiveGroupBy(section: TableSection, prefs: SectionPrefs): string | undefined {
  const g = prefs.groupBy ?? section.groupBy;
  return !g || g === GROUP_NONE ? undefined : g;
}

/** Same convention as `SectionDefinition.groupKey` in the extension. */
export function groupKeyOf(row: TableRow, groupBy: string, sectionGroupBy: string | undefined): string {
  if (groupBy === "kind") return row.kind;
  if (groupBy === "namespace") return row.namespace ?? "(cluster)";
  if (groupBy === "status") return row.level;
  if (groupBy.startsWith("label:")) return row.labels[groupBy.slice(6)] ?? "(none)";
  return (groupBy === sectionGroupBy ? row.groupKey : undefined) ?? "(none)";
}

export interface GroupByOption {
  readonly value: string;
  readonly label: string;
}

export function groupByOptions(section: TableSection): GroupByOption[] {
  const options: GroupByOption[] = [
    { value: GROUP_NONE, label: l10n.t("None") },
    { value: "namespace", label: l10n.t("Namespace") },
    { value: "status", label: l10n.t("Status") },
    { value: "kind", label: l10n.t("Kind") },
  ];
  const keys = new Set<string>();
  for (const r of section.rows) for (const k of Object.keys(r.labels)) keys.add(k);
  for (const k of [...keys].sort()) options.push({ value: `label:${k}`, label: l10n.t("Label: {0}", k) });
  const def = section.groupBy;
  if (def && !options.some((o) => o.value === def)) options.push({ value: def, label: l10n.t("Default ({0})", def) });
  return options;
}

/** Copy `prefs` with one changed key; `undefined` removes the key (exactOptionalPropertyTypes). */
export function withPref<K extends keyof SectionPrefs>(
  prefs: SectionPrefs,
  key: K,
  value: SectionPrefs[K] | undefined,
): SectionPrefs {
  const next: Record<string, unknown> = { ...prefs };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as SectionPrefs;
}

/** Move column `id` to `target`'s position (drag and drop or Alt+←/→). */
export function moveColumn(order: readonly string[], id: string, target: string): string[] {
  const from = order.indexOf(id);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = order.filter((c) => c !== id);
  next.splice(to, 0, id);
  return next;
}

export function initialColumnOrder(section: TableSection, prefs: SectionPrefs): string[] {
  const ids = section.columns.map((c) => c.id);
  const ordered = (prefs.columnOrder ?? []).filter((id) => ids.includes(id));
  return [...ordered, ...ids.filter((id) => !ordered.includes(id))];
}

export function initialVisibility(section: TableSection, prefs: SectionPrefs): Record<string, boolean> {
  const hidden = prefs.hidden;
  return Object.fromEntries(section.columns.map((c) => [c.id, hidden ? !hidden.includes(c.id) : !c.hidden]));
}

export function initialSizing(section: TableSection, prefs: SectionPrefs): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const c of section.columns) {
    const w = prefs.widths?.[c.id] ?? c.width;
    if (w !== undefined) sizes[c.id] = w;
  }
  return sizes;
}
