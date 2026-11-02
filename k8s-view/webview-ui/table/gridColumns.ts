import {
  type ColumnDef,
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
  createFilteredRowModel,
  createGroupedRowModel,
  createSortedRowModel,
  type FilterFn,
  globalFilteringFeature,
  type Row,
  rowExpandingFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";
import * as l10n from "@vscode/l10n";
import type { StatusLevel, TableColumn, TableRow } from "../../src/shared/protocol";
import {
  type ColumnPredicate,
  compileColumnFilter,
  type FilterRender,
  type FilterTarget,
  parseSearch,
  slug,
} from "./filterExpr";
import { compareSortValues, groupKeyOf } from "./model";

export const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  columnGroupingFeature,
  rowSortingFeature,
  rowExpandingFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  filteredRowModel: createFilteredRowModel(),
  groupedRowModel: createGroupedRowModel(),
  sortedRowModel: createSortedRowModel(),
  expandedRowModel: createExpandedRowModel(),
});

export type Features = typeof features;
export type GridRow = Row<Features, TableRow>;

/** Implicit columns; the `__` prefix avoids collisions with section column IDs. */
export const COL = {
  select: "__select",
  status: "__status",
  name: "__name",
  namespace: "__namespace",
  group: "__group",
} as const;

export const FIXED_COLUMNS: readonly string[] = [COL.select, COL.status, COL.name, COL.namespace];

const LEVEL_RANK: Record<StatusLevel, number> = { error: 0, warning: 1, progress: 2, unknown: 3, ok: 4 };

export function columnTitle(id: string, columns: readonly TableColumn[]): string {
  switch (id) {
    case COL.select:
      return l10n.t("Selection");
    case COL.status:
      return l10n.t("Status");
    case COL.name:
      return l10n.t("Name");
    case COL.namespace:
      return l10n.t("Namespace");
    default:
      return columns.find((c) => c.id === id)?.title ?? id;
  }
}

/** Column filter value: filter-row expression plus search qualifiers (AND-ed), with `now` for age comparisons. */
export interface ColumnFilterValue {
  readonly exprs: readonly string[];
  readonly now: number;
}

export function isFilterableColumn(id: string): boolean {
  return id !== COL.select && id !== COL.group;
}

export function filterRender(id: string, columns: readonly TableColumn[]): FilterRender {
  if (id === COL.status) return "level";
  return columns.find((c) => c.id === id)?.render ?? "text";
}

const predicates = new Map<string, ColumnPredicate>();

/** Compiled filters are cached: the grid filters again on every live update. */
export function predicateFor(expr: string, render: FilterRender): ColumnPredicate {
  const key = `${render}\u0000${expr}`;
  let p = predicates.get(key);
  if (!p) {
    if (predicates.size > 500) predicates.clear();
    p = compileColumnFilter(expr, render);
    predicates.set(key, p);
  }
  return p;
}

/** What column filters see of a row (text includes badges). */
export function filterTarget(r: TableRow, id: string, index: ReadonlyMap<string, number>): FilterTarget {
  if (id === COL.name) return { text: r.name, sort: r.name };
  if (id === COL.namespace) return { text: r.namespace ?? "", sort: r.namespace ?? null };
  if (id === COL.status) return { text: r.level, sort: null };
  const i = index.get(id);
  const c = i === undefined ? undefined : r.cells[i];
  if (!c) return { text: "", sort: null };
  return { text: c.badges && c.badges.length > 0 ? `${c.text} ${c.badges.join(" ")}` : c.text, sort: c.sort };
}

export function exprFilter(columns: readonly TableColumn[]): FilterFn<Features, TableRow> {
  const index = new Map(columns.map((c, i) => [c.id, i]));
  return (row, columnId, value) => {
    const v = value as ColumnFilterValue | undefined;
    if (!v || v.exprs.length === 0) return true;
    const render = filterRender(columnId, columns);
    const target = filterTarget(row.original, columnId, index);
    return v.exprs.every((e) => predicateFor(e, render).test(target, v.now));
  };
}

/** Search keys: fixed columns first, then section column titles (slug) and IDs, which win on conflicts (Pod "Status"). */
export function searchKeyResolver(columns: readonly TableColumn[]): (key: string) => string | undefined {
  const keys = new Map<string, string>([
    ["name", COL.name],
    ["namespace", COL.namespace],
    ["level", COL.status],
    ["status", COL.status],
  ]);
  for (const c of columns) keys.set(slug(c.title), c.id);
  for (const c of columns) keys.set(c.id.toLowerCase(), c.id);
  return (key) => keys.get(key.toLowerCase());
}

/** tanstack column filter state from the filter row and search qualifiers; unknown column IDs are dropped. */
export function columnFilterState(
  columns: readonly TableColumn[],
  rowFilters: Readonly<Record<string, string>> | undefined,
  searchColumns: Readonly<Record<string, readonly string[]>>,
  now: number,
): { id: string; value: ColumnFilterValue }[] {
  const known = new Set([...FIXED_COLUMNS, ...columns.map((c) => c.id)]);
  const exprs = new Map<string, string[]>();
  for (const [id, e] of Object.entries(rowFilters ?? {})) if (known.has(id) && e.trim() !== "") exprs.set(id, [e]);
  for (const [id, list] of Object.entries(searchColumns)) {
    if (known.has(id)) exprs.set(id, [...(exprs.get(id) ?? []), ...list]);
  }
  return [...exprs].map(([id, list]) => ({ id, value: { exprs: list, now } }));
}

/** First invalid qualifier in the search box, for the input's error state. */
export function searchError(input: string, columns: readonly TableColumn[]): string | undefined {
  const { columns: filters } = parseSearch(input, searchKeyResolver(columns));
  for (const [id, list] of Object.entries(filters)) {
    for (const e of list) {
      const error = predicateFor(e, filterRender(id, columns)).error;
      if (error) return error;
    }
  }
  return undefined;
}

const searchCache = new WeakMap<TableRow, string>();

/** Search text for the entire row, used by the global filter (including `k=v` labels). */
export function rowSearchText(r: TableRow): string {
  let text = searchCache.get(r);
  if (text === undefined) {
    const parts = [r.name, r.namespace ?? "", r.kind, r.summary ?? "", ...(r.resourceWarnings ?? [])];
    for (const c of r.cells) parts.push(c.text, ...(c.badges ?? []));
    for (const [k, v] of Object.entries(r.labels)) parts.push(`${k}=${v}`);
    text = parts.join("\n").toLowerCase();
    searchCache.set(r, text);
  }
  return text;
}

/** Global filter: attach only to the Name column so each row is checked once. */
export const globalFilter: FilterFn<Features, TableRow> = (row, _columnId, value) => {
  const needle = String(value ?? "")
    .trim()
    .toLowerCase();
  return needle === "" || rowSearchText(row.original).includes(needle);
};

const sortFn = (a: GridRow, b: GridRow, id: string) =>
  compareSortValues(a.getValue<string | number>(id), b.getValue<string | number>(id));

export function buildColumns(
  columns: readonly TableColumn[],
  sectionGroupBy: string | undefined,
  groupBy: string | undefined,
): ColumnDef<Features, TableRow, unknown>[] {
  const filterFn = exprFilter(columns);
  const common = { sortFn, sortUndefined: "last" as const, filterFn };
  return [
    {
      id: COL.select,
      size: 30,
      enableSorting: false,
      enableResizing: false,
      enableColumnFilter: false,
      enableGlobalFilter: false,
      enableHiding: false,
    },
    {
      id: COL.status,
      accessorFn: (r) => LEVEL_RANK[r.level],
      size: 30,
      enableResizing: false,
      enableGlobalFilter: false,
      ...common,
    },
    { id: COL.name, accessorFn: (r) => r.name, size: 240, ...common },
    { id: COL.namespace, accessorFn: (r) => r.namespace ?? undefined, size: 140, ...common },
    ...columns.map(
      (c, i): ColumnDef<Features, TableRow, unknown> => ({
        id: c.id,
        accessorFn: (r) => r.cells[i]?.sort ?? undefined,
        size: c.width ?? (c.render === "age" ? 72 : 140),
        ...common,
      }),
    ),
    {
      id: COL.group,
      accessorFn: (r) => (groupBy ? groupKeyOf(r, groupBy, sectionGroupBy, columns) : ""),
      enableColumnFilter: false,
      enableGlobalFilter: false,
    },
  ];
}
