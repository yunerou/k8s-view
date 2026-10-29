import { describe, expect, test } from "vitest";
import type { FilterConfig } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { CompiledFilter } from "../../../src/core/view/Filter";
import { matchesSelector } from "../../../src/core/view/labelSelector";
import { StatusEvaluator } from "../../../src/core/view/StatusEvaluator";
import { kinds, res } from "../helpers/fixtures";

const engine = new ExpressionEngine("safe");

describe("CompiledFilter", () => {
  const ks = res(kinds.kustomization, "apps", {
    spec: { suspend: true, interval: "5m" },
    metadata: { name: "apps", uid: "k1", labels: { tier: "infra" } },
  });
  const job = res(kinds.job, "manual", {
    metadata: {
      name: "manual",
      uid: "j1",
      ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "c", uid: "c1" }],
    },
  });

  test.each([
    [{ path: "$.spec.suspend", op: "eq", value: true }, true],
    [{ path: "$.spec.suspend", op: "neq", value: true }, false],
    [{ path: "$.spec.missing", op: "neq", value: true }, true],
    [{ path: "$.spec.interval", op: "in", value: ["1m", "5m"] }, true],
    [{ path: "$.spec.interval", op: "exists" }, true],
    [{ path: "$.spec.nope", op: "notExists" }, true],
    [{ path: "$.metadata.labels.tier", op: "regex", value: "^inf" }, true],
  ] as [FilterConfig, boolean][])("%j → %s", (cfg, expected) => {
    expect(new CompiledFilter(cfg, engine).test(ks)).toBe(expected);
  });

  test("owner ops", () => {
    expect(new CompiledFilter({ op: "ownedBy", value: "CronJob" }, engine).test(job)).toBe(true);
    expect(new CompiledFilter({ op: "notOwnedBy", value: "CronJob" }, engine).test(job)).toBe(false);
    expect(new CompiledFilter({ op: "notOwnedBy", value: "batch/CronJob" }, engine).test(ks)).toBe(true);
  });

  test("array of conditions is AND", () => {
    const f = new CompiledFilter(
      [
        { path: "$.spec.suspend", op: "eq", value: true },
        { path: "$.spec.interval", op: "eq", value: "1m" },
      ],
      engine,
    );
    expect(f.test(ks)).toBe(false);
  });
});

describe("matchesSelector", () => {
  const labels = { app: "web", tier: "fe" };
  test.each([
    [{ app: "web" }, true],
    [{ app: "api" }, false],
    [{}, false],
    [undefined, false],
    [{ matchLabels: { app: "web" } }, true],
    [{ matchExpressions: [{ key: "tier", operator: "In", values: ["fe", "be"] }] }, true],
    [{ matchExpressions: [{ key: "tier", operator: "NotIn", values: ["fe"] }] }, false],
    [{ matchExpressions: [{ key: "x", operator: "DoesNotExist" }] }, true],
    [{ matchLabels: { app: "web" }, matchExpressions: [{ key: "x", operator: "Exists" }] }, false],
  ])("%j → %s", (selector, expected) => {
    expect(matchesSelector(selector, labels)).toBe(expected);
  });
});

describe("StatusEvaluator", () => {
  const status = new StatusEvaluator(engine);

  test("pod preset", () => {
    const running = res(kinds.pod, "a", {
      status: {
        phase: "Running",
        containerStatuses: [{ name: "c", ready: true, restartCount: 0, state: { running: {} } }],
      },
    });
    const crash = res(kinds.pod, "b", {
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "c", ready: false, restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    });
    const pending = res(kinds.pod, "c", { status: { phase: "Pending" } });
    const done = res(kinds.pod, "d", { status: { phase: "Succeeded" } });
    const terminating = res(kinds.pod, "e", {
      metadata: { name: "e", uid: "e", deletionTimestamp: "2026-10-22T00:00:00Z" },
      status: { phase: "Running" },
    });
    expect(status.evaluate(running, { preset: "pod" })).toEqual({ level: "ok", summary: "Running" });
    expect(status.evaluate(crash, { preset: "pod" })).toEqual({ level: "error", summary: "CrashLoopBackOff" });
    expect(status.evaluate(pending, { preset: "pod" }).level).toBe("progress");
    expect(status.evaluate(done, { preset: "pod" })).toEqual({ level: "ok", summary: "Completed" });
    expect(status.evaluate(terminating, { preset: "pod" })).toEqual({ level: "progress", summary: "Terminating" });
  });

  test("replicas preset", () => {
    const ok = res(kinds.deployment, "a", { spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 3 } });
    const partial = res(kinds.deployment, "b", {
      spec: { replicas: 2 },
      status: { readyReplicas: 1, updatedReplicas: 2 },
    });
    const none = res(kinds.deployment, "c", { spec: { replicas: 2 }, status: {} });
    const zero = res(kinds.deployment, "d", { spec: { replicas: 0 }, status: {} });
    const ds = res(kinds.daemonSet, "e", {
      status: { desiredNumberScheduled: 3, numberReady: 3, updatedNumberScheduled: 3 },
    });
    expect(status.evaluate(ok, { preset: "replicas" })).toEqual({ level: "ok", summary: "3/3" });
    expect(status.evaluate(partial, { preset: "replicas" })).toEqual({ level: "warning", summary: "1/2" });
    expect(status.evaluate(none, { preset: "replicas" })).toEqual({ level: "error", summary: "0/2" });
    expect(status.evaluate(zero, { preset: "replicas" })).toEqual({ level: "ok", summary: "0/0" });
    expect(status.evaluate(ds, { preset: "replicas" })).toEqual({ level: "ok", summary: "3/3" });
  });

  test("job preset", () => {
    const complete = res(kinds.job, "a", {
      spec: { completions: 1 },
      status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
    });
    const failed = res(kinds.job, "b", { status: { failed: 1, conditions: [{ type: "Failed", status: "True" }] } });
    const running = res(kinds.job, "c", { spec: { completions: 3 }, status: { active: 1, succeeded: 1 } });
    expect(status.evaluate(complete, { preset: "job" })).toEqual({ level: "ok", summary: "Complete" });
    expect(status.evaluate(failed, { preset: "job" })).toEqual({ level: "error", summary: "Failed" });
    expect(status.evaluate(running, { preset: "job" })).toEqual({ level: "progress", summary: "1/3" });
  });

  test("readyCondition preset", () => {
    const ready = res(kinds.kustomization, "a", {
      status: { conditions: [{ type: "Ready", status: "True", reason: "ReconciliationSucceeded" }] },
    });
    const failed = res(kinds.kustomization, "b", {
      status: { conditions: [{ type: "Ready", status: "False", reason: "BuildFailed" }] },
    });
    const reconciling = res(kinds.kustomization, "c", {
      status: {
        conditions: [
          { type: "Ready", status: "Unknown", reason: "Progressing" },
          { type: "Reconciling", status: "True" },
        ],
      },
    });
    const suspended = res(kinds.kustomization, "d", {
      spec: { suspend: true },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    expect(status.evaluate(ready, { preset: "readyCondition" })).toEqual({
      level: "ok",
      summary: "ReconciliationSucceeded",
    });
    expect(status.evaluate(failed, { preset: "readyCondition" })).toEqual({ level: "error", summary: "BuildFailed" });
    expect(status.evaluate(reconciling, { preset: "readyCondition" }).level).toBe("progress");
    expect(status.evaluate(suspended, { preset: "readyCondition" })).toEqual({
      level: "warning",
      summary: "Suspended",
    });
    expect(status.evaluate(res(kinds.kustomization, "e"), { preset: "readyCondition" }).level).toBe("unknown");
  });

  test("rules: first match wins, default otherwise", () => {
    const cfg = {
      rules: [
        { when: { path: "$.spec.type", op: "eq" as const, value: "LoadBalancer" }, level: "warning" as const },
        { when: { path: "$.spec.type", op: "exists" as const }, level: "ok" as const },
      ],
      default: "unknown" as const,
    };
    expect(status.evaluate(res(kinds.service, "lb", { spec: { type: "LoadBalancer" } }), cfg).level).toBe("warning");
    expect(status.evaluate(res(kinds.service, "c", { spec: { type: "ClusterIP" } }), cfg).level).toBe("ok");
    expect(status.evaluate(res(kinds.service, "n"), cfg).level).toBe("unknown");
  });

  test("auto-detect when no config", () => {
    expect(status.evaluate(res(kinds.pod, "a", { status: { phase: "Failed" } }), undefined).level).toBe("error");
    expect(status.evaluate(res(kinds.cronJob, "c", { spec: { suspend: true } }), undefined)).toEqual({
      level: "warning",
      summary: "Suspended",
    });
    expect(status.evaluate(res(kinds.configMap, "x"), undefined)).toEqual({ level: "unknown" });
  });
});
