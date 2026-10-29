import { describe, expect, test } from "vitest";
import { ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import { metricAlert, podBudgetWarnings, podResourceWarnings } from "../../../src/core/resource/resourceAlerts";
import { withResourceMetrics } from "../../../src/core/resource/resourceMetrics";
import { kindViewConfig } from "../../../src/core/view/kindView";
import { compileView } from "../../../src/core/view/ViewDefinition";
import { kinds, res } from "../helpers/fixtures";

const budget = { requests: { cpu: "1", memory: "1G" }, limits: { cpu: "2", memory: "2G" } };
const columns = compileView(ViewSchema.parse(kindViewConfig({ group: "", kind: "Pod" })), new ExpressionEngine("safe"))
  .view.sections[0]!.columns;
const metricKind = new ResourceKind("metrics.k8s.io", "v1beta1", "PodMetrics", "pods", true);

function measured(percent: number) {
  return withResourceMetrics(
    res(kinds.pod, "p", { spec: { containers: [{ name: "app", resources: budget }] } }),
    res(metricKind, "p", { containers: [{ usage: { cpu: String(percent / 100), memory: String(percent * 1e7) } }] }),
  );
}

describe("resource threshold colors", () => {
  test.each([
    [0, "ok"],
    [79, "ok"],
    [80, "warning"],
    [99, "warning"],
    [100, "error"],
    [150, "error"],
  ])("colors usage at %s%% as %s and keeps numeric sort", (percent, level) => {
    const pod = measured(Number(percent));
    for (const r of ["cpu", "memory"]) {
      const used = columns.find((c) => c.id === `${r}-used`)!.evaluate(pod, 0);
      const ratio = columns.find((c) => c.id === `${r}-percent`)!.evaluate(pod, 0);
      expect(used.level).toBe(level);
      expect(ratio.level).toBe(level);
      expect(ratio.sort).toBeCloseTo(Number(percent));
      expect(ratio.tooltip).toContain("of request");
      expect(columns.find((c) => c.id === `${r}-request`)!.evaluate(pod, 0).level).toBeUndefined();
    }
  });

  test("missing usage or zero request has no threshold color", () => {
    const pod = withResourceMetrics(
      res(kinds.pod, "p", { spec: { containers: [{ name: "app", resources: budget }] } }),
      undefined,
    );
    expect(columns.find((c) => c.id === "cpu-percent")!.evaluate(pod, 0)).toEqual({ text: "-", sort: null });
    const zero = res(kinds.pod, "p", { resourceMetrics: { cpu: { used: 1, request: 0 } } });
    expect(metricAlert(zero, "cpu", "used")).toEqual({});
    const invalid = res(kinds.pod, "p", { resourceMetrics: { cpu: { percent: Infinity, used: 1, request: 1 } } });
    expect(metricAlert(invalid, "cpu", "percent")).toEqual({});
  });
});

describe("Pod resource configuration warnings", () => {
  test("reports each missing CPU/Memory budget without requiring Metrics Server", () => {
    const pod = res(kinds.pod, "p", { spec: { containers: [{ name: "app" }] } });
    expect(podResourceWarnings(pod)).toEqual([
      "Missing CPU request: app.",
      "Missing CPU limit: app.",
      "Missing Memory request: app.",
      "Missing Memory limit: app.",
    ]);
    expect(columns.find((c) => c.id === "cpu-request")!.evaluate(pod, 0)).toEqual({
      text: "-",
      sort: null,
      level: "warning",
      tooltip: "Missing CPU request: app.",
    });
  });

  test("warns for a partially configured Pod even when its aggregate request is nonzero", () => {
    const pod = withResourceMetrics(
      res(kinds.pod, "p", { spec: { containers: [{ name: "app", resources: budget }, { name: "sidecar" }] } }),
      undefined,
    );
    expect(podBudgetWarnings(pod, "cpu", "request")).toEqual(["Missing CPU request: sidecar."]);
    expect(columns.find((c) => c.id === "cpu-request")!.evaluate(pod, 0)).toEqual({
      text: "1",
      sort: 1,
      level: "warning",
      tooltip: "Missing CPU request: sidecar.",
    });
    expect(podBudgetWarnings(pod, "memory", "limit")).toEqual(["Missing Memory limit: sidecar."]);
  });

  test("includes init containers and restartable sidecars, and distinguishes zero from missing", () => {
    const pod = res(kinds.pod, "p", {
      spec: {
        containers: [{ name: "app", resources: budget }],
        initContainers: [
          { name: "setup" },
          { name: "proxy", restartPolicy: "Always", resources: { requests: { cpu: "0" } } },
        ],
      },
    });
    expect(podBudgetWarnings(pod, "cpu", "request")).toEqual([
      "Missing CPU request: init setup.",
      "CPU request is 0: init proxy.",
    ]);
  });

  test("respects Pod-level budgets per resource and does not mark Node or other kinds", () => {
    const covered = res(kinds.pod, "p", { spec: { containers: [{ name: "app" }], resources: budget } });
    expect(podResourceWarnings(covered)).toEqual([]);
    const partial = res(kinds.pod, "p", {
      spec: { containers: [{ name: "app" }], resources: { requests: { cpu: "1" } } },
    });
    expect(podBudgetWarnings(partial, "cpu", "request")).toEqual([]);
    expect(podBudgetWarnings(partial, "cpu", "limit")).toEqual(["Missing CPU limit: app."]);
    const node = res(new ResourceKind("", "v1", "Node", "nodes", false), "n");
    expect(podResourceWarnings(node)).toEqual([]);
    expect(podResourceWarnings(res(kinds.deployment, "d"))).toEqual([]);
    expect(podResourceWarnings(res(kinds.pod, "p"))).toEqual([]);
  });
});
