// biome-ignore-all lint/a11y/useSemanticElements: div-based ARIA grid because rows are absolutely positioned (virtual scrolling).
import type { Header } from "@tanstack/react-table";
import * as l10n from "@vscode/l10n";
import { type DragEvent, useRef, useState } from "react";
import type { TableColumn, TableRow } from "../../src/shared/protocol";
import { COL, columnTitle, type Features, isTextColumn } from "../table/gridColumns";
import { moveColumn } from "../table/model";
import { Codicon } from "./Codicon";

const REORDER_EDGE_GAP = 14;
const DRAG_TYPE = "application/x-k8s-view-column";

type GridHeaderCell = Header<Features, TableRow, unknown>;

export interface GridHeaderProps {
  readonly headers: readonly GridHeaderCell[];
  readonly sectionColumns: readonly TableColumn[];
  /** Section column order (only these columns can be dragged). */
  readonly sectionOrder: readonly string[];
  readonly width: number;
  /** Column holding the header tab stop; -1 when focus is in the table body. */
  readonly focusCol: number;
  readonly onFocusCol: (col: number) => void;
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly onToggleAll: () => void;
  readonly onReorder: (order: string[]) => void;
  readonly showFilters: boolean;
}

function ariaSort(h: GridHeaderCell): "ascending" | "descending" | "none" | undefined {
  if (!h.column.getCanSort()) return undefined;
  const s = h.column.getIsSorted();
  return s === "asc" ? "ascending" : s === "desc" ? "descending" : "none";
}

export function GridHeader(props: GridHeaderProps) {
  const { headers, sectionColumns, sectionOrder } = props;
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const dragAllowed = useRef<boolean | undefined>(undefined);
  const movable = (id: string) => sectionOrder.includes(id);

  const onDragOver = (e: DragEvent, id: string) => {
    if (!dragging || !movable(id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  };
  const onDrop = (e: DragEvent, id: string) => {
    e.preventDefault();
    if (dragging && movable(id) && dragging !== id) props.onReorder(moveColumn(sectionOrder, dragging, id));
    setDragging(undefined);
    setDropTarget(undefined);
  };

  return (
    <div role="rowgroup" className="grid-header" style={{ width: props.width }}>
      {/* biome-ignore lint/a11y/useFocusableInteractive: focus is on columnheader (roving tabindex). */}
      <div role="row" aria-rowindex={1} className="grid-row header-row">
        {headers.map((h, ci) => {
          const id = h.column.id;
          const title = columnTitle(id, sectionColumns);
          const sorted = h.column.getIsSorted();
          const canResize = h.column.getCanResize();
          const resize = h.getResizeHandler();
          const cls = [
            "grid-cell",
            "header-cell",
            h.column.getCanSort() ? "sortable" : "",
            dropTarget === id && dragging !== id ? "drop-target" : "",
            dragging === id ? "dragging" : "",
            h.column.getIsResizing() ? "resizing" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the grid's onKeyDown.
            <div
              key={h.id}
              role="columnheader"
              aria-sort={ariaSort(h)}
              aria-label={id === COL.select || id === COL.status ? title : undefined}
              tabIndex={props.focusCol === ci ? 0 : -1}
              data-row={-1}
              data-col={ci}
              className={cls}
              style={{ width: h.getSize() }}
              title={movable(id) ? l10n.t("{0} — drag to reorder, Alt+←/→ to move", title) : title}
              draggable={movable(id)}
              onMouseDown={(e) => {
                const bounds = e.currentTarget.getBoundingClientRect();
                const offset = e.clientX - bounds.left;
                dragAllowed.current = offset >= REORDER_EDGE_GAP && offset <= bounds.width - REORDER_EDGE_GAP;
              }}
              onFocus={() => props.onFocusCol(ci)}
              onClick={id === COL.select ? props.onToggleAll : h.column.getToggleSortingHandler()}
              onDragStart={(e) => {
                const bounds = e.currentTarget.getBoundingClientRect();
                const offset = e.clientX - bounds.left;
                if (
                  !movable(id) ||
                  dragAllowed.current === false ||
                  offset < REORDER_EDGE_GAP ||
                  offset > bounds.width - REORDER_EDGE_GAP ||
                  h.column.getIsResizing()
                ) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.setData(DRAG_TYPE, id);
                e.dataTransfer.effectAllowed = "move";
                setDragging(id);
              }}
              onDragOver={(e) => onDragOver(e, id)}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={(e) => onDrop(e, id)}
              onDragEnd={() => {
                dragAllowed.current = undefined;
                setDragging(undefined);
                setDropTarget(undefined);
              }}
            >
              {id === COL.select ? (
                <input
                  type="checkbox"
                  tabIndex={-1}
                  readOnly
                  checked={props.allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = props.someSelected && !props.allSelected;
                  }}
                  aria-label={l10n.t("Select all")}
                />
              ) : id === COL.status ? (
                <Codicon name="circle-filled" className="muted" />
              ) : (
                <span className="header-label">{title}</span>
              )}
              {sorted && <Codicon name={sorted === "asc" ? "arrow-up" : "arrow-down"} className="sort-icon" />}
              {canResize && (
                <div
                  className="resizer"
                  aria-hidden="true"
                  draggable={false}
                  onDragStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    resize(e);
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    resize(e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={() => h.column.resetSize()}
                />
              )}
            </div>
          );
        })}
      </div>
      {props.showFilters && (
        // biome-ignore lint/a11y/useFocusableInteractive: cells contain inputs.
        <div role="row" className="grid-row filter-row">
          {headers.map((h) => {
            const id = h.column.id;
            const canFilter = isTextColumn(id) && h.column.getCanFilter();
            return (
              <div
                key={h.id}
                role="gridcell"
                tabIndex={-1}
                className="grid-cell filter-cell"
                style={{ width: h.getSize() }}
              >
                {canFilter && (
                  <input
                    type="text"
                    className="input"
                    placeholder={l10n.t("Filter")}
                    aria-label={l10n.t("Filter {0}", columnTitle(id, sectionColumns))}
                    value={String(h.column.getFilterValue() ?? "")}
                    onChange={(e) => h.column.setFilterValue(e.target.value || undefined)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
