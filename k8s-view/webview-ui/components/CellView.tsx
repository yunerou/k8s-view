import * as l10n from "@vscode/l10n";
import type { TableCell, TableColumn } from "../../src/shared/protocol";
import { formatAge } from "../shared/format";
import { StatusDot } from "./StatusDot";

function Badges({ items }: { readonly items: readonly string[] }) {
  return (
    <span className="badges">
      {items.map((b) => (
        <span key={b} className="badge" title={b}>
          {b}
        </span>
      ))}
    </span>
  );
}

/** Render a cell according to `column.render`. */
export function CellView({
  column,
  cell,
  now,
}: {
  readonly column: TableColumn;
  readonly cell: TableCell | undefined;
  readonly now: number;
}) {
  if (!cell) return null;
  switch (column.render) {
    case "status":
      return (
        <span className="cell-status">
          <StatusDot level={cell.level ?? "unknown"} />
          <span className="cell-text">{cell.text}</span>
        </span>
      );
    case "badge":
    case "labels":
      return cell.badges && cell.badges.length > 0 ? (
        <Badges items={cell.badges} />
      ) : (
        <span className="cell-text">{cell.text}</span>
      );
    case "boolean": {
      const on = cell.sort === 1 || cell.sort === "true" || /^(true|yes)$/i.test(cell.text);
      return (
        <span className="cell-bool" title={cell.text}>
          {on ? (
            <span className="codicon codicon-check" role="img" aria-label={l10n.t("Yes")} />
          ) : (
            <span className="cell-text muted">{cell.text}</span>
          )}
        </span>
      );
    }
    case "cpu":
    case "memory":
    case "percentage":
      return cell.level ? (
        <span className={`cell-metric level-${cell.level}`} title={cell.tooltip ?? cell.text}>
          <StatusDot level={cell.level} label={cell.tooltip ?? cell.text} />
          <span className="cell-text">{cell.text}</span>
        </span>
      ) : (
        <span className="cell-text" title={cell.tooltip ?? cell.text}>
          {cell.text}
        </span>
      );
    case "age":
      return (
        <span
          className="cell-text"
          title={cell.timestamp === undefined ? cell.text : new Date(cell.timestamp).toISOString()}
        >
          {cell.timestamp === undefined ? cell.text : formatAge(cell.timestamp, now)}
        </span>
      );
    default:
      return (
        <span className="cell-text" title={cell.text}>
          {cell.text}
        </span>
      );
  }
}
