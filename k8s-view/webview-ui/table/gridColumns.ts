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
const NOT_TEXT = new Set<string>([COL.select, COL.status, COL.group]);

const LEVEL_RANK: Record<StatusLevel, number> = { error: 0, warning: 1, progress: 2, unknown: 3, ok: 4 };

export function isTextColumn(id: string): boolean {
  return !NOT_TEXT.has(id);
}

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

/** Text used for filtering (global and per-column). */
export function textOf(r: TableRow, id: string, index: ReadonlyMap<string, number>): string {
  if (id === COL.name) return r.name;
  if (id === COL.namespace) return r.namespace ?? "";
  if (id === COL.status) return r.level;
  const i = index.get(id);
  const c = i === undefined ? undefined : r.cells[i];
  if (!c) return "";
  return c.badges && c.badges.length > 0 ? `${c.text} ${c.badges.join(" ")}` : c.text;
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

export function textFilter(columns: readonly TableColumn[]): FilterFn<Features, TableRow> {
  const index = new Map(columns.map((c, i) => [c.id, i]));
  return (row, columnId, value) => {
    const needle = String(value ?? "")
      .trim()
      .toLowerCase();
    return needle === "" || textOf(row.original, columnId, index).toLowerCase().includes(needle);
  };
}

const sortFn = (a: GridRow, b: GridRow, id: string) =>
  compareSortValues(a.getValue<string | number>(id), b.getValue<string | number>(id));

export function buildColumns(
  columns: readonly TableColumn[],
  sectionGroupBy: string | undefined,
  groupBy: string | undefined,
): ColumnDef<Features, TableRow, unknown>[] {
  const filterFn = textFilter(columns);
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
      enableColumnFilter: false,
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
      accessorFn: (r) => (groupBy ? groupKeyOf(r, groupBy, sectionGroupBy) : ""),
      enableColumnFilter: false,
      enableGlobalFilter: false,
    },
  ];
}
