// biome-ignore-all lint/a11y/useSemanticElements: div-based ARIA grid because rows are absolutely positioned (virtual scrolling).
import {
  type ColumnFiltersState,
  type ExpandedState,
  functionalUpdate,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as l10n from "@vscode/l10n";
import {
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SectionPrefs, StatusLevel, TableRow, TableSection } from "../../src/shared/protocol";
import { useNow } from "../shared/hooks";
import { buildColumns, COL, FIXED_COLUMNS, features, type GridRow, globalFilter } from "../table/gridColumns";
import {
  effectiveGroupBy,
  initialColumnOrder,
  initialSizing,
  initialVisibility,
  moveColumn,
  withPref,
} from "../table/model";
import { CellView } from "./CellView";
import { GridHeader } from "./GridHeader";
import { StatusDot } from "./StatusDot";

export const ROW_HEIGHT = 24;
const AGE_REFRESH_MS = 30_000;

export interface ResourceGridProps {
  readonly section: TableSection;
  readonly prefs: SectionPrefs;
  readonly onPrefsChange: (prefs: SectionPrefs) => void;
  readonly showFilters: boolean;
  readonly selection: ReadonlySet<string>;
  readonly onSelectionChange: (selection: ReadonlySet<string>) => void;
  /** UIDs that just changed (brief highlight). */
  readonly flash: ReadonlySet<string>;
  readonly onContextMenu: (uids: string[], x: number, y: number) => void;
  readonly onOpenDetails: (uid: string) => void;
  /** Allow table hotkeys to operate using the grid's order/focus. */
  readonly handle?: Ref<GridHandle>;
}

export interface GridHandle {
  /** Selected rows in display order; the focused row if none are selected. */
  targets(): string[];
  /** Select and focus the next (`1`) / previous (`-1`) row with `level`, wrapping at the ends. */
  jumpTo(level: StatusLevel, dir: 1 | -1): void;
  /** Commands menu for `targets()`, positioned at the focused row. */
  openMenu(): void;
}

type SelectMode = "replace" | "toggle" | "range";

/** Cell holding the tab stop (roving tabindex); `row = -1` is the header row. */
interface FocusPos {
  readonly row: number;
  readonly col: number;
}

export function ResourceGrid(props: ResourceGridProps) {
  const { section, prefs, onPrefsChange, showFilters, selection, onSelectionChange } = props;
  const now = useNow(AGE_REFRESH_MS);
  const groupBy = effectiveGroupBy(section, prefs);

  const columns = useMemo(
    () => buildColumns(section.columns, section.groupBy, groupBy),
    [section.columns, section.groupBy, groupBy],
  );
  const sectionOrder = useMemo(() => initialColumnOrder(section, prefs), [section, prefs]);
  const sorting = useMemo<SortingState>(() => (prefs.sort ? [{ ...prefs.sort }] : []), [prefs.sort]);
  const columnOrder = useMemo(() => [...FIXED_COLUMNS, ...sectionOrder, COL.group], [sectionOrder]);
  const columnVisibility = useMemo(
    () => ({
      ...initialVisibility(section, prefs),
      [COL.namespace]: section.showNamespace,
      [COL.group]: false,
    }),
    [section, prefs],
  );
  const columnSizing = useMemo(() => ({ ...initialSizing(section, prefs), ...prefs.widths }), [section, prefs]);
  const grouping = useMemo(() => (groupBy ? [COL.group] : []), [groupBy]);

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const activeFilters = showFilters ? columnFilters : [];

  const table = useTable({
    features,
    columns,
    data: section.rows,
    getRowId: (r: TableRow) => r.uid,
    state: {
      sorting,
      globalFilter: prefs.filter ?? "",
      columnFilters: activeFilters,
      grouping,
      expanded,
      columnOrder,
      columnVisibility,
      columnSizing,
    },
    onSortingChange: (u) => {
      const s = functionalUpdate(u, sorting)[0];
      onPrefsChange(withPref(prefs, "sort", s ? { id: s.id, desc: s.desc } : undefined));
    },
    onColumnFiltersChange: (u) => setColumnFilters((old) => functionalUpdate(u, old)),
    onExpandedChange: (u) => setExpanded((old) => functionalUpdate(u, old)),
    onColumnSizingChange: (u) => onPrefsChange(withPref(prefs, "widths", functionalUpdate(u, columnSizing))),
    globalFilterFn: globalFilter,
    getColumnCanGlobalFilter: (c: { readonly id: string }) => c.id === COL.name,
    groupedColumnMode: false,
    columnResizeMode: "onChange",
    autoResetAll: false,
    sortDescFirst: false,
    enableMultiSort: false,
  });

  const rows = table.getRowModel().rows;
  const leafRows = useMemo(() => rows.filter((r) => !r.getIsGrouped()), [rows]);
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const colCount = headers.length;
  const totalWidth = table.getTotalSize();

  // ── Virtual scroll ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rows[i]?.id ?? i,
    overscan: 12,
  });

  // ── Selection ──
  const anchor = useRef<string | undefined>(undefined);
  const selectRow = (uid: string, mode: SelectMode) => {
    if (mode === "range" && anchor.current !== undefined) {
      const ids = leafRows.map((r) => r.id);
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(uid);
      if (a >= 0 && b >= 0) {
        onSelectionChange(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    anchor.current = uid;
    if (mode === "toggle") {
      const next = new Set(selection);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      onSelectionChange(next);
    } else onSelectionChange(new Set([uid]));
  };
  const selectedInOrder = (extra?: string) =>
    leafRows.filter((r) => selection.has(r.id) || r.id === extra).map((r) => r.id);
  const allSelected = leafRows.length > 0 && leafRows.every((r) => selection.has(r.id));
  const toggleAll = () => onSelectionChange(allSelected ? new Set() : new Set(leafRows.map((r) => r.id)));

  /** Open a row's menu: if not selected, select only that row. */
  const openMenu = (uid: string, x: number, y: number) => {
    if (selection.has(uid)) {
      props.onContextMenu(selectedInOrder(), x, y);
    } else {
      anchor.current = uid;
      onSelectionChange(new Set([uid]));
      props.onContextMenu([uid], x, y);
    }
  };

  // ── Roving focus ──
  const [focus, setFocus] = useState<FocusPos>({ row: 0, col: 2 });
  const fRow = Math.max(-1, Math.min(focus.row, rows.length - 1));
  const fCol = Math.max(0, Math.min(focus.col, colCount - 1));
  const pendingFocus = useRef(false);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const root = fRow < 0 ? headRef.current : scrollRef.current;
    const sel =
      fRow >= 0 && rows[fRow]?.getIsGrouped() ? `[data-row="${fRow}"]` : `[data-row="${fRow}"][data-col="${fCol}"]`;
    const el = root?.querySelector<HTMLElement>(sel);
    if (el) {
      pendingFocus.current = false;
      el.focus();
    }
  });

  const moveFocus = (row: number, col: number) => {
    const r = Math.max(-1, Math.min(row, rows.length - 1));
    const c = Math.max(0, Math.min(col, colCount - 1));
    setFocus({ row: r, col: c });
    pendingFocus.current = true;
    if (r >= 0) virtualizer.scrollToIndex(r, { align: "auto" });
  };

  const focusedUid = () => {
    const row = fRow >= 0 ? rows[fRow] : undefined;
    return row && !row.getIsGrouped() ? row.id : undefined;
  };

  useImperativeHandle(props.handle, () => ({
    targets: () => {
      if (selection.size > 0) return selectedInOrder();
      const uid = focusedUid();
      return uid ? [uid] : [];
    },
    jumpTo: (level, dir) => {
      const hits = rows.flatMap((r, i) => (!r.getIsGrouped() && r.original.level === level ? [i] : []));
      if (hits.length === 0) return;
      const next =
        dir === 1 ? (hits.find((i) => i > fRow) ?? hits[0]!) : (hits.findLast((i) => i < fRow) ?? hits.at(-1)!);
      const uid = rows[next]!.id;
      anchor.current = uid;
      onSelectionChange(new Set([uid]));
      moveFocus(next, fCol);
    },
    openMenu: () => {
      const uid = selection.size > 0 ? selectedInOrder()[0] : focusedUid();
      if (!uid) return;
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row="${fRow}"]`) ?? scrollRef.current;
      const rect = el?.getBoundingClientRect();
      openMenu(uid, (rect?.left ?? 0) + 8, rect?.bottom ?? 0);
    },
  }));

  const reorderBy = (id: string, delta: number) => {
    const i = sectionOrder.indexOf(id);
    const target = sectionOrder[i + delta];
    if (i >= 0 && target) onPrefsChange(withPref(prefs, "columnOrder", moveColumn(sectionOrder, id, target)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return;
    const row: GridRow | undefined = fRow >= 0 ? rows[fRow] : undefined;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const headerId = fRow < 0 ? headers[fCol]?.column.id : undefined;
    switch (e.key) {
      case "ArrowDown":
        moveFocus(fRow + 1, fCol);
        break;
      case "ArrowUp":
        moveFocus(fRow - 1, fCol);
        break;
      case "ArrowRight":
        if (e.altKey && headerId) reorderBy(headerId, 1);
        else if (row?.getIsGrouped() && !row.getIsExpanded()) row.toggleExpanded(true);
        else moveFocus(fRow, fCol + 1);
        break;
      case "ArrowLeft":
        if (e.altKey && headerId) reorderBy(headerId, -1);
        else if (row?.getIsGrouped() && row.getIsExpanded()) row.toggleExpanded(false);
        else moveFocus(fRow, fCol - 1);
        break;
      case "Home":
        moveFocus(e.ctrlKey ? 0 : fRow, 0);
        break;
      case "End":
        moveFocus(e.ctrlKey ? rows.length - 1 : fRow, colCount - 1);
        break;
      case "PageDown":
        moveFocus(fRow + page, fCol);
        break;
      case "PageUp":
        moveFocus(Math.max(0, fRow - page), fCol);
        break;
      case " ":
      case "Enter":
        if (headerId) {
          if (headerId === COL.select) toggleAll();
          else headers[fCol]?.column.getToggleSortingHandler()?.(e);
        } else if (row?.getIsGrouped()) row.toggleExpanded();
        else if (row && e.key === " ") selectRow(row.id, e.shiftKey ? "range" : "toggle");
        else if (row) props.onOpenDetails(row.id);
        break;
      case "a":
        if (!(e.ctrlKey || e.metaKey)) return;
        onSelectionChange(new Set(leafRows.map((r) => r.id)));
        break;
      default: {
        const menuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
        if (!menuKey || !row || row.getIsGrouped()) return;
        const rect = target.getBoundingClientRect();
        openMenu(row.id, rect.left + 8, rect.bottom);
      }
    }
    e.preventDefault();
  };

  const onRowClick = (e: MouseEvent, uid: string) =>
    selectRow(uid, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "replace");

  const renderCell = (id: string, r: TableRow, selected: boolean) => {
    switch (id) {
      case COL.select:
        return (
          <input
            type="checkbox"
            tabIndex={-1}
            checked={selected}
            readOnly
            aria-label={l10n.t("Select {0}", r.name)}
            onClick={(e) => {
              e.stopPropagation();
              selectRow(r.uid, e.shiftKey ? "range" : "toggle");
            }}
          />
        );
      case COL.status:
        return <StatusDot level={r.level} />;
      case COL.name:
        return (
          <>
            <span className="cell-text name" title={r.summary ?? r.name}>
              {r.name}
            </span>
            {r.resourceWarnings && r.resourceWarnings.length > 0 && (
              <span
                className="codicon codicon-warning resource-warning text-warning"
                role="img"
                aria-label={`${l10n.t("Resource configuration warning")}: ${r.resourceWarnings.join(" ")}`}
                title={r.resourceWarnings.join("\n")}
              />
            )}
          </>
        );
      case COL.namespace:
        return <span className="cell-text">{r.namespace ?? ""}</span>;
      default: {
        const i = section.columns.findIndex((c) => c.id === id);
        const column = section.columns[i];
        return column ? <CellView column={column} cell={r.cells[i]} now={now} /> : null;
      }
    }
  };

  const filtered = (prefs.filter ?? "") !== "" || activeFilters.length > 0;

  return (
    <div
      className="grid"
      role="grid"
      aria-label={section.title}
      aria-rowcount={rows.length + (showFilters ? 2 : 1)}
      aria-colcount={colCount}
      aria-multiselectable="true"
      aria-busy={section.state === "loading"}
      onKeyDown={onKeyDown}
    >
      <div className="grid-head" ref={headRef}>
        <GridHeader
          headers={headers}
          sectionColumns={section.columns}
          sectionOrder={sectionOrder}
          width={totalWidth}
          focusCol={fRow < 0 ? fCol : -1}
          onFocusCol={(col) => setFocus({ row: -1, col })}
          allSelected={allSelected}
          someSelected={selection.size > 0}
          onToggleAll={toggleAll}
          onReorder={(order) => onPrefsChange(withPref(prefs, "columnOrder", order))}
          showFilters={showFilters}
        />
      </div>
      <div
        className="grid-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div
          role="rowgroup"
          data-part="body"
          className="grid-body"
          style={{ height: virtualizer.getTotalSize(), width: totalWidth }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            const style = { transform: `translateY(${vi.start}px)`, height: ROW_HEIGHT, width: totalWidth };
            if (row.getIsGrouped()) {
              const open = row.getIsExpanded();
              const isFocus = fRow === vi.index;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: focus is on gridcell (roving tabindex).
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={vi.index + 2}
                  aria-expanded={open}
                  aria-level={1}
                  className="grid-row group-row"
                  style={style}
                >
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the grid's onKeyDown. */}
                  <div
                    role="gridcell"
                    aria-colspan={colCount}
                    tabIndex={isFocus ? 0 : -1}
                    data-row={vi.index}
                    className="grid-cell group-cell"
                    onFocus={() => setFocus({ row: vi.index, col: fCol })}
                    onClick={() => row.toggleExpanded()}
                  >
                    <span className={`codicon codicon-${open ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
                    <span className="group-key">{String(row.groupingValue ?? "")}</span>
                    <span className="count-badge">{row.subRows.length}</span>
                  </div>
                </div>
              );
            }
            const r = row.original;
            const selected = selection.has(r.uid);
            const cls = `grid-row${selected ? " selected" : ""}${props.flash.has(r.uid) ? " flash" : ""} level-${r.level}`;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the grid's onKeyDown.
              // biome-ignore lint/a11y/useFocusableInteractive: focus is on gridcell (roving tabindex).
              <div
                key={row.id}
                role="row"
                data-uid={r.uid}
                aria-rowindex={vi.index + 2}
                aria-selected={selected}
                aria-level={groupBy ? 2 : undefined}
                className={cls}
                style={style}
                onClick={(e) => onRowClick(e, r.uid)}
                onDoubleClick={() => props.onOpenDetails(r.uid)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(r.uid, e.clientX, e.clientY);
                }}
              >
                {row.getVisibleCells().map((c, ci) => (
                  <div
                    key={c.id}
                    role="gridcell"
                    tabIndex={fRow === vi.index && fCol === ci ? 0 : -1}
                    data-row={vi.index}
                    data-col={ci}
                    className="grid-cell"
                    style={{ width: c.column.getSize() }}
                    onFocus={() => setFocus({ row: vi.index, col: ci })}
                  >
                    {renderCell(c.column.id, r, selected)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && section.state === "ready" && (
          <div className="grid-empty">
            {filtered ? l10n.t("No resources match the filter.") : l10n.t("No resources.")}
          </div>
        )}
      </div>
    </div>
  );
}
