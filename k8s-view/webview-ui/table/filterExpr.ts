import * as l10n from "@vscode/l10n";
import type { RenderKind } from "../../src/shared/protocol";
import { parseQuantity } from "../../src/shared/quantity";

/** `level` = the implicit status column (matched on `TableRow.level`). */
export type FilterRender = RenderKind | "level";

/** What a column filter sees of a cell. */
export interface FilterTarget {
  readonly text: string;
  readonly sort: string | number | null;
}

export interface ColumnPredicate {
  /** Set when the expression is invalid; the predicate then accepts every row. */
  readonly error: string | undefined;
  test(target: FilterTarget, now: number): boolean;
}

type Test = (target: FilterTarget, now: number) => boolean;

const COMPARE = /^(>=|<=|>|<)\s*(.*)$/s;
const TEXT_OP = /^(!=|=|!)?\s*(.*)$/s;
const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `30s`, `5m`, `1h`, `2d`, `1w`; a bare number is seconds. Returns milliseconds. */
export function parseDuration(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([smhdw]?)$/.exec(value);
  return m ? Number(m[1]) * UNITS[m[2] || "s"]! : undefined;
}

function parsePlainNumber(value: string): number | undefined {
  const n = Number(value);
  return value !== "" && Number.isFinite(n) ? n : undefined;
}

/** Comparison operand in the unit of `TableCell.sort` (age: milliseconds of age). */
function parseOperand(value: string, render: FilterRender): number | undefined {
  switch (render) {
    case "age":
      return parseDuration(value);
    case "cpu":
    case "memory":
      return parseQuantity(value);
    case "percentage":
      return parsePlainNumber(value.endsWith("%") ? value.slice(0, -1) : value);
    default:
      return parsePlainNumber(value);
  }
}

/** One `|` branch: a test, or an error message. */
function compileBranch(branch: string, render: FilterRender): Test | string {
  const cmp = COMPARE.exec(branch);
  if (cmp) {
    const op = cmp[1]!;
    const raw = cmp[2]!.trim();
    if (render === "level") return l10n.t("Comparisons are not supported for this column");
    if (raw === "") return l10n.t("Missing value after {0}", op);
    const operand = parseOperand(raw, render);
    if (operand === undefined) return l10n.t("'{0}' is not a valid value for this column", raw);
    return (t, now) => {
      if (typeof t.sort !== "number") return false;
      const v = render === "age" ? now - t.sort : t.sort;
      return op === ">" ? v > operand : op === ">=" ? v >= operand : op === "<" ? v < operand : v <= operand;
    };
  }
  const m = TEXT_OP.exec(branch)!;
  const op = m[1] ?? "";
  const needle = m[2]!.trim().toLowerCase();
  if (op === "!" && needle === "") return l10n.t("Missing value after {0}", op);
  switch (op) {
    case "=":
      return (t) => t.text.toLowerCase() === needle;
    case "!=":
      return (t) => t.text.toLowerCase() !== needle;
    case "!":
      return (t) => !t.text.toLowerCase().includes(needle);
    default:
      return (t) => t.text.toLowerCase().includes(needle);
  }
}

const ACCEPT_ALL: ColumnPredicate = { error: undefined, test: () => true };

/** Compile `a|>5|!=x` (branches OR-ed) for a column rendered as `render`. */
export function compileColumnFilter(expr: string, render: FilterRender): ColumnPredicate {
  const branches = expr
    .split("|")
    .map((b) => b.trim())
    .filter((b) => b !== "");
  if (branches.length === 0) return ACCEPT_ALL;
  const tests: Test[] = [];
  for (const b of branches) {
    const test = compileBranch(b, render);
    if (typeof test === "string") return { error: test, test: () => true };
    tests.push(test);
  }
  return { error: undefined, test: (target, now) => tests.some((t) => t(target, now)) };
}

export interface ParsedSearch {
  /** Free text for the row-wide search. */
  readonly text: string;
  /** Column ID → expressions from `key:expr` tokens. */
  readonly columns: Readonly<Record<string, readonly string[]>>;
}

const TOKEN = /(?:[^\s"]+|"[^"]*"?)+/g;
const QUALIFIER = /^([A-Za-z0-9._-]+):(.*)$/s;

/** Split the search box into `key:expr` column filters (known keys only) and free text. */
export function parseSearch(input: string, resolveKey: (key: string) => string | undefined): ParsedSearch {
  const text: string[] = [];
  const columns: Record<string, string[]> = {};
  for (const token of input.match(TOKEN) ?? []) {
    const m = QUALIFIER.exec(token);
    const id = m ? resolveKey(m[1]!) : undefined;
    if (!m || id === undefined) {
      text.push(token.replaceAll('"', ""));
      continue;
    }
    const expr = m[2]!.replaceAll('"', "");
    if (expr.trim() === "") continue;
    const list = columns[id] ?? [];
    list.push(expr);
    columns[id] = list;
  }
  return { text: text.join(" "), columns };
}

/** Same as the extension's column ID slug (`core/view/merge.ts`). */
export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "column";
}
