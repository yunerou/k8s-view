import type { StatusConfig, StatusLevel, StatusRuleConfig } from "../config/schema";
import type { ExpressionEngine } from "../expression/ExpressionEngine";
import type { KubeResource } from "../resource/KubeResource";
import { CompiledFilter } from "./Filter";

export interface StatusResult {
  readonly level: StatusLevel;
  /** Short description/tooltip summary: `3/3`, `CrashLoopBackOff`… */
  readonly summary?: string;
  /** Rule-defined tree icon/color (e.g. CronJob Pods: gray dots when complete). */
  readonly icon?: string;
  readonly color?: string;
}

const REPLICA_KINDS = new Set(["apps/Deployment", "apps/StatefulSet", "apps/ReplicaSet", "apps/DaemonSet"]);
const ERROR_REASONS = /BackOff|Err|Invalid|OOMKilled|Error|Failed/;

type Obj = Record<string, unknown>;

/** Compute status level (ok / warning / error / progress / unknown) using presets, rules, or kind-based inference. */
export class StatusEvaluator {
  private readonly rules = new WeakMap<object, { filter: CompiledFilter; rule: StatusRuleConfig }[]>();

  constructor(private readonly engine: ExpressionEngine) {}

  evaluate(resource: KubeResource, config: StatusConfig | undefined): StatusResult {
    if (!config) return this.auto(resource);
    if ("preset" in config) {
      switch (config.preset) {
        case "pod":
          return pod(resource);
        case "replicas":
          return replicas(resource);
        case "job":
          return job(resource);
        case "readyCondition":
          return readyCondition(resource);
      }
    }
    for (const { filter, rule } of this.compiledRules(config)) {
      if (!filter.test(resource)) continue;
      return {
        level: rule.level,
        ...(rule.summary ? { summary: rule.summary } : {}),
        ...(rule.icon ? { icon: rule.icon } : {}),
        ...(rule.color ? { color: rule.color } : {}),
      };
    }
    return { level: config.default };
  }

  /** Compile ahead of time to report JSONPath errors at config load rather than render time. */
  compile(config: StatusConfig | undefined): void {
    if (config && "rules" in config) this.compiledRules(config);
  }

  private compiledRules(config: Extract<StatusConfig, { rules: unknown }>) {
    let compiled = this.rules.get(config);
    if (!compiled) {
      compiled = config.rules.map((rule) => ({ filter: new CompiledFilter(rule.when, this.engine), rule }));
      this.rules.set(config, compiled);
    }
    return compiled;
  }

  private auto(r: KubeResource): StatusResult {
    const key = r.kind.key;
    if (key === "/Pod") return pod(r);
    if (REPLICA_KINDS.has(key)) return replicas(r);
    if (key === "batch/Job") return job(r);
    if (key === "batch/CronJob") return cronJob(r);
    if (r.condition("Ready")) return readyCondition(r);
    return { level: "unknown" };
  }
}

function spec(r: KubeResource): Obj {
  return (r.object["spec"] as Obj | undefined) ?? {};
}
function status(r: KubeResource): Obj {
  return (r.object["status"] as Obj | undefined) ?? {};
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

function pod(r: KubeResource): StatusResult {
  if (r.object.metadata.deletionTimestamp) return { level: "progress", summary: "Terminating" };
  const st = status(r);
  const phase = String(st["phase"] ?? "Unknown");
  const containers = [...((st["initContainerStatuses"] as Obj[]) ?? []), ...((st["containerStatuses"] as Obj[]) ?? [])];
  for (const c of containers) {
    const state = (c["state"] as Obj | undefined) ?? {};
    const waiting = state["waiting"] as Obj | undefined;
    const terminated = state["terminated"] as Obj | undefined;
    const reason = String(
      waiting?.["reason"] ?? (terminated && num(terminated["exitCode"]) !== 0 ? terminated["reason"] : "") ?? "",
    );
    if (reason && ERROR_REASONS.test(reason)) return { level: "error", summary: reason };
  }
  switch (phase) {
    case "Succeeded":
      return { level: "ok", summary: "Completed" };
    case "Failed":
      return { level: "error", summary: String(st["reason"] ?? "Failed") };
    case "Pending":
      return { level: "progress", summary: "Pending" };
    case "Running": {
      const regular = (st["containerStatuses"] as Obj[] | undefined) ?? [];
      const ready = regular.every((c) => c["ready"] === true);
      return ready ? { level: "ok", summary: "Running" } : { level: "warning", summary: "NotReady" };
    }
    default:
      return { level: "unknown", summary: phase };
  }
}

function replicas(r: KubeResource): StatusResult {
  const st = status(r);
  const isDaemonSet = r.kind.key === "apps/DaemonSet";
  const desired = isDaemonSet ? num(st["desiredNumberScheduled"]) : num(spec(r)["replicas"], 1);
  const ready = isDaemonSet ? num(st["numberReady"]) : num(st["readyReplicas"]);
  const summary = `${ready}/${desired}`;
  if (desired === 0) return { level: "ok", summary };
  if (ready >= desired) {
    const updated = isDaemonSet ? st["updatedNumberScheduled"] : st["updatedReplicas"];
    const rolling = typeof updated === "number" && updated < desired;
    return { level: rolling ? "progress" : "ok", summary };
  }
  return { level: ready === 0 ? "error" : "warning", summary };
}

function job(r: KubeResource): StatusResult {
  const st = status(r);
  if (r.condition("Failed")?.status === "True") return { level: "error", summary: "Failed" };
  if (r.condition("Complete")?.status === "True") return { level: "ok", summary: "Complete" };
  if (spec(r)["suspend"] === true) return { level: "warning", summary: "Suspended" };
  const completions = num(spec(r)["completions"], 1);
  return { level: num(st["active"]) > 0 ? "progress" : "unknown", summary: `${num(st["succeeded"])}/${completions}` };
}

function cronJob(r: KubeResource): StatusResult {
  if (spec(r)["suspend"] === true) return { level: "warning", summary: "Suspended" };
  const active = (status(r)["active"] as unknown[] | undefined)?.length ?? 0;
  return active > 0 ? { level: "progress", summary: `${active} active` } : { level: "ok" };
}

function readyCondition(r: KubeResource): StatusResult {
  if (spec(r)["suspend"] === true) return { level: "warning", summary: "Suspended" };
  if (r.condition("Stalled")?.status === "True")
    return { level: "error", summary: r.condition("Stalled")?.reason ?? "Stalled" };
  const ready = r.condition("Ready");
  if (!ready) return { level: "unknown" };
  const summary = ready.reason ?? ready.status;
  if (ready.status === "True") return { level: "ok", summary };
  if (ready.status === "False") {
    return r.condition("Reconciling")?.status === "True" ? { level: "progress", summary } : { level: "error", summary };
  }
  return { level: "progress", summary };
}
