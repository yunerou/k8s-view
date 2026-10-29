import { describe, expect, test } from "vitest";
import { buildRow, buildSection, diffSection, EMPTY_SNAPSHOT } from "../../../src/app/TableModel";
import type { SectionContent } from "../../../src/app/ViewSession";
import { ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { compileView } from "../../../src/core/view/ViewDefinition";
import { kinds, res } from "../helpers/fixtures";

const now = Date.parse("2026-10-22T00:00:00Z");
const view = compileView(
  ViewSchema.parse({
    id: "w",
    title: "W",
    sections: [
      {
        id: "pods",
        title: "Pods",
        icon: "symbol-class",
        resources: [{ kind: "Pod" }],
        groupBy: "namespace",
        status: { preset: "pod" },
        columns: [
          { title: "Phase", path: "$.status.phase", render: "status" },
          { title: "Age", path: "$.metadata.creationTimestamp", render: "age", hidden: true },
        ],
      },
    ],
  }),
  new ExpressionEngine("safe"),
).view;
const section = view.sections[0]!;

const p1 = res(
  kinds.pod,
  "a",
  {
    metadata: { name: "a", uid: "u1", labels: { app: "x" }, creationTimestamp: "2026-10-21T00:00:00Z" },
    status: { phase: "Running" },
  },
  "ns1",
);
const p2 = res(kinds.pod, "b", { metadata: { name: "b", uid: "u2" }, status: { phase: "Pending" } }, "ns2");
const content = (items = [p1, p2]): SectionContent => ({ state: "ready", items, groups: undefined, problems: [] });

describe("TableModel", () => {
  test("buildRow evaluates cells, status and group key", () => {
    expect(buildRow(section, p1, now)).toEqual({
      uid: "u1",
      group: "",
      kind: "Pod",
      name: "a",
      namespace: "ns1",
      level: "ok",
      summary: "Running",
      cells: [
        { text: "Running", sort: "Running", level: "ok" },
        { text: "24h", sort: Date.parse("2026-10-21T00:00:00Z"), timestamp: Date.parse("2026-10-21T00:00:00Z") },
      ],
      labels: { app: "x" },
      groupKey: "ns1",
      creationTimestamp: Date.parse("2026-10-21T00:00:00Z"),
    });
  });

  test("buildSection describes columns and namespace visibility", () => {
    const s = buildSection(section, content(), true, now);
    expect(s.columns).toEqual([
      { id: "phase", title: "Phase", render: "status", hidden: false },
      { id: "age", title: "Age", render: "age", hidden: true },
    ]);
    expect(s.showNamespace).toBe(true);
    expect(s.groupBy).toBe("namespace");
    expect(s.rows.map((r) => r.uid)).toEqual(["u1", "u2"]);
    expect(buildSection(section, content(), false, now).showNamespace).toBe(false);
  });

  test("diffSection reports only changed, added and removed rows", () => {
    const first = diffSection("pods", EMPTY_SNAPSHOT, buildSection(section, content(), true, now));
    expect(first.patch.upserts.map((r) => r.uid)).toEqual(["u1", "u2"]);
    const p1b = res(
      kinds.pod,
      "a",
      {
        metadata: { name: "a", uid: "u1", labels: { app: "x" }, creationTimestamp: "2026-10-21T00:00:00Z" },
        status: { phase: "Failed" },
      },
      "ns1",
    );
    const p3 = res(kinds.pod, "c", { metadata: { name: "c", uid: "u3" } }, "ns1");
    const second = diffSection("pods", first.snapshot, buildSection(section, content([p1b, p3]), true, now));
    expect(second.patch.upserts.map((r) => r.uid)).toEqual(["u1", "u3"]);
    expect(second.patch.removes).toEqual(["u2"]);
    expect(second.patch.order).toEqual(["u1", "u3"]);
    const third = diffSection("pods", second.snapshot, buildSection(section, content([p1b, p3]), true, now + 60_000));
    expect(third.changed).toBe(false);
  });

  test("diffSection reports an empty section that finished loading", () => {
    const loading = diffSection(
      "pods",
      EMPTY_SNAPSHOT,
      buildSection(section, { ...content([]), state: "loading" }, true, now),
    );
    const ready = diffSection("pods", loading.snapshot, buildSection(section, content([]), true, now));
    expect(ready.changed).toBe(true);
    expect(ready.patch.state).toBe("ready");
    expect(diffSection("pods", ready.snapshot, buildSection(section, content([]), true, now)).changed).toBe(false);
  });
});

test("Pod budget warnings survive table patches and clear when budgets are configured", () => {
  const pod = res(kinds.pod, "p", { spec: { containers: [{ name: "app" }] }, status: { phase: "Running" } });
  const first = diffSection("pods", EMPTY_SNAPSHOT, buildSection(section, content([pod]), false, now));
  expect(first.patch.upserts[0]!.resourceWarnings).toContain("Missing CPU request: app.");
  expect(first.patch.upserts[0]!.level).toBe("ok");
  const configured = res(kinds.pod, "p", {
    metadata: pod.object.metadata,
    spec: {
      containers: [
        { name: "app", resources: { requests: { cpu: "1", memory: "1G" }, limits: { cpu: "2", memory: "2G" } } },
      ],
    },
    status: { phase: "Running" },
  });
  const next = diffSection("pods", first.snapshot, buildSection(section, content([configured]), false, now));
  expect(next.changed).toBe(true);
  expect(next.patch.upserts[0]!.resourceWarnings).toBeUndefined();
});
