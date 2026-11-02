import { describe, expect, test } from "vitest";
import { parseQuantity } from "../../../src/shared/quantity";
import {
  compileColumnFilter,
  type FilterRender,
  type FilterTarget,
  parseDuration,
  parseSearch,
  slug,
} from "../../../webview-ui/table/filterExpr";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const t = (text: string, sort: string | number | null = text): FilterTarget => ({ text, sort });
const match = (expr: string, render: FilterRender, target: FilterTarget) =>
  compileColumnFilter(expr, render).test(target, NOW);

describe("compileColumnFilter", () => {
  test("plain text is a case-insensitive substring; = is exact; ! and != negate", () => {
    expect(match("run", "status", t("Running"))).toBe(true);
    expect(match("=running", "status", t("Running"))).toBe(true);
    expect(match("=run", "status", t("Running"))).toBe(false);
    expect(match("!=running", "status", t("Running"))).toBe(false);
    expect(match("!pend", "status", t("Running"))).toBe(true);
    expect(match("!run", "status", t("Running"))).toBe(false);
  });

  test("| combines branches with OR and ignores empty branches", () => {
    expect(match("Pending|Running", "status", t("Running"))).toBe(true);
    expect(match("Pending|", "status", t("Running"))).toBe(false);
    expect(match(" | ", "status", t("Running"))).toBe(true);
  });

  test("numeric comparisons use the cell sort value", () => {
    expect(match(">0", "text", t("3", 3))).toBe(true);
    expect(match(">0", "text", t("0", 0))).toBe(false);
    expect(match(">=3", "count", t("3", 3))).toBe(true);
    expect(match("<=2", "count", t("3", 3))).toBe(false);
    expect(match(">0", "text", t("-", null))).toBe(false);
    expect(match(">0", "text", t("abc", "abc"))).toBe(false);
  });

  test("age compares the age (now - timestamp) with durations", () => {
    const thirtyMinutes = t("30m", NOW - 30 * 60_000);
    const twoDays = t("2d", NOW - 2 * 86_400_000);
    expect(match("<1h", "age", thirtyMinutes)).toBe(true);
    expect(match("<1h", "age", twoDays)).toBe(false);
    expect(match(">1d", "age", twoDays)).toBe(true);
    expect(match(">90", "age", thirtyMinutes)).toBe(true);
  });

  test("cpu, memory and percentage operands use Kubernetes units", () => {
    expect(match(">500m", "cpu", t("750m", 0.75))).toBe(true);
    expect(match(">1", "cpu", t("750m", 0.75))).toBe(false);
    expect(match(">=1Gi", "memory", t("1G", 1e9))).toBe(false);
    expect(match(">512Mi", "memory", t("1G", 1e9))).toBe(true);
    expect(match(">100%", "percentage", t("120%", 120))).toBe(true);
    expect(match(">100", "percentage", t("80%", 80))).toBe(false);
  });

  test("invalid expressions report an error and accept every row", () => {
    const cases: [string, FilterRender][] = [
      [">abc", "text"],
      [">", "count"],
      ["!", "text"],
      [">1", "level"],
      [">1x", "age"],
    ];
    for (const [expr, render] of cases) {
      const p = compileColumnFilter(expr, render);
      expect(p.error, expr).toBeTruthy();
      expect(p.test(t("x", 1), NOW)).toBe(true);
    }
    expect(compileColumnFilter(">1", "text").error).toBeUndefined();
    expect(compileColumnFilter("error|warning", "level").error).toBeUndefined();
  });
});

describe("units", () => {
  test("parseDuration returns milliseconds; bare numbers are seconds", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("2x")).toBeUndefined();
  });

  test("parseQuantity is shared with the webview", () => {
    expect(parseQuantity("500m")).toBe(0.5);
    expect(parseQuantity("1Ki")).toBe(1024);
  });
});

describe("parseSearch", () => {
  const known: Record<string, string> = { restarts: "restarts", node: "node", name: "__name" };
  const keys = (k: string) => known[k.toLowerCase()];

  test("splits qualifiers from free text", () => {
    expect(parseSearch("restarts:>0 nginx Node:worker-1", keys)).toEqual({
      text: "nginx",
      columns: { restarts: [">0"], node: ["worker-1"] },
    });
  });

  test("quoted values keep spaces; repeated keys accumulate", () => {
    expect(parseSearch('node:"a b" node:!c', keys)).toEqual({ text: "", columns: { node: ["a b", "!c"] } });
  });

  test("unknown keys and URLs stay free text; empty qualifiers are ignored", () => {
    expect(parseSearch("http://x.io foo:bar name:", keys)).toEqual({ text: "http://x.io foo:bar", columns: {} });
  });

  test("an unclosed quote does not throw", () => {
    expect(() => parseSearch('node:"a b', keys)).not.toThrow();
  });
});

test("slug matches the column ID generated from a title", () => {
  expect(slug("CPU Used/Req %")).toBe("cpu-used-req");
  expect(slug("Restarts")).toBe("restarts");
});
