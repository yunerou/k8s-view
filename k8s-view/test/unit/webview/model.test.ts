import { describe, expect, test } from "vitest";
import { formatAge } from "../../../webview-ui/shared/format";
import {
  applyPatch,
  compareSortValues,
  effectiveGroupBy,
  groupByOptions,
  groupKeyOf,
  initialColumnOrder,
  initialSizing,
  initialVisibility,
  moveColumn,
  withPref,
} from "../../../webview-ui/table/model";
import { model, row, section } from "./fixtures";

describe("applyPatch", () => {
  const base = model([section("deployments", [row("a"), row("b"), row("c")]), section("pods", [row("p1")])]);

  test("upserts, removes and reorders by `order`", () => {
    const next = applyPatch(base, {
      sectionId: "deployments",
      upserts: [row("b", { level: "error" }), row("d")],
      removes: ["a"],
      state: "ready",
      problems: ["forbidden: pods"],
      order: ["d", "c", "b"],
    });
    const s = next.sections[0]!;
    expect(s.rows.map((r) => r.uid)).toEqual(["d", "c", "b"]);
    expect(s.rows[2]!.level).toBe("error");
    expect(s.problems).toEqual(["forbidden: pods"]);
    expect(next.sections[1]).toBe(base.sections[1]);
    expect(base.sections[0]!.rows.map((r) => r.uid)).toEqual(["a", "b", "c"]);
  });

  test("keeps rows missing from `order` at the end in their previous order", () => {
    const next = applyPatch(base, {
      sectionId: "deployments",
      upserts: [],
      removes: [],
      state: "loading",
      problems: [],
      order: ["c"],
    });
    expect(next.sections[0]!.rows.map((r) => r.uid)).toEqual(["c", "a", "b"]);
    expect(next.sections[0]!.state).toBe("loading");
  });

  test("ignores a patch for an unknown section", () => {
    const next = applyPatch(base, {
      sectionId: "nope",
      upserts: [],
      removes: [],
      state: "ready",
      problems: [],
      order: [],
    });
    expect(next).toBe(base);
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  test.each([
    [45 * 1000, "45s"],
    [5 * 60 * 1000 + 10_000, "5m"],
    [5 * 3600 * 1000, "5h"],
    [2 * 86400 * 1000 + 3600_000, "2d"],
    [400 * 86400 * 1000, "1y"],
    [2 * 365 * 86400 * 1000 + 86400_000, "2y"],
    [0, "0s"],
    [-500, "0s"],
  ])("%d ms → %s", (delta, expected) => {
    expect(formatAge(now - delta, now)).toBe(expected);
  });

  test("far future is invalid", () => {
    expect(formatAge(now + 60_000, now)).toBe("<invalid>");
  });
});

describe("compareSortValues", () => {
  test("numbers numerically, strings naturally, mixed numbers first", () => {
    const values = ["pod-10", 3, "pod-2", 20, "Alpha"];
    expect([...values].sort(compareSortValues)).toEqual([3, 20, "Alpha", "pod-2", "pod-10"]);
  });
});

describe("grouping helpers", () => {
  const r = row("a", { namespace: "team-a", level: "warning", labels: { app: "web" }, groupKey: "custom" });

  test("groupKeyOf supports namespace, status, kind, label and the section default", () => {
    expect(groupKeyOf(r, "namespace", undefined)).toBe("team-a");
    expect(groupKeyOf(r, "status", undefined)).toBe("warning");
    expect(groupKeyOf(r, "kind", undefined)).toBe("Deployment");
    expect(groupKeyOf(r, "label:app", undefined)).toBe("web");
    expect(groupKeyOf(r, "label:tier", undefined)).toBe("(none)");
    expect(groupKeyOf(r, "$.spec.x", "$.spec.x")).toBe("custom");
    expect(groupKeyOf({ ...r, namespace: undefined }, "namespace", undefined)).toBe("(cluster)");
  });

  test("effectiveGroupBy prefers prefs, then the section default; 'none' disables", () => {
    const s = section("deployments", [r], { groupBy: "namespace" });
    expect(effectiveGroupBy(s, {})).toBe("namespace");
    expect(effectiveGroupBy(s, { groupBy: "status" })).toBe("status");
    expect(effectiveGroupBy(s, { groupBy: "none" })).toBeUndefined();
    expect(effectiveGroupBy(section("x", [r]), {})).toBeUndefined();
  });

  test("groupByOptions lists label keys present and the section default", () => {
    const s = section("deployments", [r, row("b", { labels: { tier: "db", app: "db" } })], { groupBy: "$.spec.x" });
    expect(groupByOptions(s).map((o) => o.value)).toEqual([
      "none",
      "namespace",
      "status",
      "kind",
      "label:app",
      "label:tier",
      "$.spec.x",
    ]);
  });
});

describe("column prefs", () => {
  const s = section("deployments", [], {
    columns: [
      { id: "ready", title: "Ready", render: "text", hidden: false, width: 80 },
      { id: "age", title: "Age", render: "age", hidden: false },
      { id: "images", title: "Images", render: "badge", hidden: true },
    ],
  });

  test("order keeps prefs order then appends new columns", () => {
    expect(initialColumnOrder(s, { columnOrder: ["age", "gone", "ready"] })).toEqual(["age", "ready", "images"]);
    expect(initialColumnOrder(s, {})).toEqual(["ready", "age", "images"]);
  });

  test("visibility uses prefs.hidden when present, else column.hidden", () => {
    expect(initialVisibility(s, {})).toEqual({ ready: true, age: true, images: false });
    expect(initialVisibility(s, { hidden: ["age"] })).toEqual({ ready: true, age: false, images: true });
  });

  test("sizing uses prefs.widths over column.width", () => {
    expect(initialSizing(s, { widths: { age: 120 } })).toEqual({ ready: 80, age: 120 });
  });

  test("moveColumn moves to the target position in both directions", () => {
    expect(moveColumn(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveColumn(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveColumn(["a", "b"], "x", "b")).toEqual(["a", "b"]);
  });

  test("withPref sets and removes keys", () => {
    expect(withPref({ filter: "x" }, "sort", { id: "age", desc: true })).toEqual({
      filter: "x",
      sort: { id: "age", desc: true },
    });
    expect(withPref({ filter: "x" }, "filter", undefined)).toEqual({});
  });
});
