import { describe, expect, test } from "vitest";
import { ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import {
  formatMetric,
  parseQuantity,
  podBudget,
  withResourceMetrics,
} from "../../../src/core/resource/resourceMetrics";
import { kindViewConfig } from "../../../src/core/view/kindView";
import { compileView } from "../../../src/core/view/ViewDefinition";
import { kinds, res } from "../helpers/fixtures";

const nodeKind = new ResourceKind("", "v1", "Node", "nodes", false);
const podMetricKind = new ResourceKind("metrics.k8s.io", "v1beta1", "PodMetrics", "pods", true);
const nodeMetricKind = new ResourceKind("metrics.k8s.io", "v1beta1", "NodeMetrics", "nodes", false);
const container = (cpu?: string, memory?: string) => ({
  resources: { requests: { cpu, memory }, limits: { cpu, memory } },
});

function values(r: ReturnType<typeof res>) {
  return r.object["resourceMetrics"];
}

describe("resource metrics", () => {
  test.each([
    ["250000000n", 0.25],
    ["100u", 0.0001],
    ["500m", 0.5],
    ["1Gi", 1073741824],
    ["500M", 5e8],
    ["1e3", 1000],
    ["0", 0],
    [undefined, undefined],
    ["oops", undefined],
  ])("parses %s", (input, expected) => {
    if (expected === undefined) expect(parseQuantity(input)).toBeUndefined();
    else expect(parseQuantity(input)).toBeCloseTo(expected, 12);
  });

  test("combines container usage and budgets in numeric units", () => {
    const pod = res(kinds.pod, "p", { spec: { containers: [container("500m", "500M"), container("500m", "500M")] } });
    const metric = res(podMetricKind, "p", {
      containers: [{ usage: { cpu: "250000000n", memory: "250M" } }, { usage: { cpu: "250m", memory: "250M" } }],
    });
    expect(values(withResourceMetrics(pod, metric))).toEqual({
      cpu: { used: 0.5, request: 1, limit: 1, percent: 50 },
      memory: { used: 5e8, request: 1e9, limit: 1e9, percent: 50 },
    });
  });

  test("handles missing usage/request and zero request without NaN or Infinity", () => {
    const pod = res(kinds.pod, "p", { spec: { containers: [{}] } });
    const metric = res(podMetricKind, "p", { containers: [{ usage: { cpu: "0", memory: "500M" } }] });
    expect(values(withResourceMetrics(pod, metric))).toMatchObject({
      cpu: { used: 0, request: undefined, percent: undefined },
      memory: { used: 5e8, limit: undefined },
    });
    expect(values(withResourceMetrics(pod, undefined))).toMatchObject({ cpu: { used: undefined } });
    const zero = res(kinds.pod, "p", { spec: { containers: [container("0")] } });
    expect(values(withResourceMetrics(zero, metric))).toMatchObject({
      cpu: { used: 0, request: 0, percent: undefined },
    });
  });

  test("effective requests include ordered init sidecars, init peak and overhead", () => {
    const pod = res(kinds.pod, "p", {
      spec: {
        containers: [container("500m")],
        initContainers: [
          { ...container("200m"), restartPolicy: "Always" },
          container("2"),
          { ...container("300m"), restartPolicy: "Always" },
        ],
        overhead: { cpu: "100m" },
      },
    });
    expect(podBudget(pod, "cpu", "requests")).toBeCloseTo(2.3);
    expect(podBudget(pod, "cpu", "limits")).toBeCloseTo(2.3);
    const podLevel = res(kinds.pod, "p", {
      spec: { containers: [container("500m")], resources: { requests: { cpu: "3" } } },
    });
    expect(podBudget(podLevel, "cpu", "requests")).toBe(3);
    const partial = res(kinds.pod, "p", { spec: { containers: [container("1"), {}] } });
    expect(podBudget(partial, "cpu", "limits")).toBeUndefined();
    expect(podBudget(partial, "cpu", "requests")).toBe(1);
  });

  test("node budgets exclude completed and other-node pods; unavailable pod data stays unknown", () => {
    const node = res(nodeKind, "n");
    const metric = res(nodeMetricKind, "n", { usage: { cpu: "500m", memory: "500M" } });
    const pod = (name: string, nodeName: string, phase: string) =>
      res(kinds.pod, name, { spec: { nodeName, containers: [container("1", "1G")] }, status: { phase } });
    expect(
      values(
        withResourceMetrics(node, metric, [
          pod("p", "n", "Running"),
          pod("done", "n", "Succeeded"),
          pod("other", "x", "Running"),
        ]),
      ),
    ).toMatchObject({ cpu: { used: 0.5, request: 1, percent: 50 }, memory: { limit: 1e9 } });
    expect(values(withResourceMetrics(node, metric))).toMatchObject({
      cpu: { used: 0.5, request: undefined, percent: undefined },
    });
  });

  test("columns format quantities, sort numerically and use a dash for missing metrics", () => {
    const section = compileView(
      ViewSchema.parse(kindViewConfig({ group: "", kind: "Pod" })),
      new ExpressionEngine("safe"),
    ).view.sections[0]!;
    const pod = withResourceMetrics(res(kinds.pod, "p"), undefined);
    expect(section.columns.filter((c) => c.usesMetrics).map((c) => c.evaluate(pod, 0))).toEqual(
      Array.from({ length: 8 }, () => ({ text: "-", sort: null })),
    );
    expect(formatMetric(5e8, "memory")).toBe("500M");
    expect(formatMetric(0.5, "cpu")).toBe("500m");
    expect(formatMetric(50, "percentage")).toBe("50%");
    const used = section.columns.find((c) => c.id === "memory-used")!;
    const metric = res(podMetricKind, "p", { containers: [{ usage: { memory: "1G" } }] });
    expect(used.evaluate(withResourceMetrics(pod, metric), 0)).toEqual({ text: "1G", sort: 1e9 });
  });
});
