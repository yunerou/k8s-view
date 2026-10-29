import type { StatusLevel } from "../config/schema";
import type { KubeResource } from "./KubeResource";
import { formatMetric, parseQuantity } from "./resourceMetrics";

type Resource = "cpu" | "memory";
type Budget = "request" | "limit";
export type MetricField = "used" | "percent" | Budget;

interface ContainerBudget {
  name?: string;
  resources?: {
    requests?: Partial<Record<Resource, string>>;
    limits?: Partial<Record<Resource, string>>;
  };
}
interface PodSpec extends ContainerBudget {
  containers?: ContainerBudget[];
  initContainers?: ContainerBudget[];
}

const resourceLabel = (resource: Resource) => (resource === "cpu" ? "CPU" : "Memory");

/** Report incomplete budgets even when another container makes the aggregate request nonzero. */
export function podBudgetWarnings(pod: KubeResource, resource: Resource, budget: Budget): string[] {
  if (pod.kind.group !== "" || pod.kind.kind !== "Pod") return [];
  const spec = pod.object["spec"] as PodSpec | undefined;
  if (!spec) return [];
  const key = budget === "request" ? "requests" : "limits";
  const podValue = parseQuantity(spec.resources?.[key]?.[resource]);
  if (podValue !== undefined) {
    return podValue > 0 ? [] : [`${resourceLabel(resource)} ${budget} is 0 at Pod level.`];
  }
  const containers = [
    ...(spec.containers ?? []).map((c, i) => ({ c, name: c.name ?? `container ${i + 1}` })),
    ...(spec.initContainers ?? []).map((c, i) => ({ c, name: `init ${c.name ?? `container ${i + 1}`}` })),
  ];
  const missing = containers.filter(({ c }) => parseQuantity(c.resources?.[key]?.[resource]) === undefined);
  const zero = containers.filter(({ c }) => parseQuantity(c.resources?.[key]?.[resource]) === 0);
  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(`Missing ${resourceLabel(resource)} ${budget}: ${missing.map(({ name }) => name).join(", ")}.`);
  }
  if (zero.length > 0) {
    warnings.push(`${resourceLabel(resource)} ${budget} is 0: ${zero.map(({ name }) => name).join(", ")}.`);
  }
  return warnings;
}

export function podResourceWarnings(pod: KubeResource): string[] {
  return (["cpu", "memory"] as const).flatMap((resource) =>
    (["request", "limit"] as const).flatMap((budget) => podBudgetWarnings(pod, resource, budget)),
  );
}

/** Presentation only: thresholds do not change the resource's Kubernetes health/status. */
export function metricAlert(
  resource: KubeResource,
  metricResource: Resource,
  field: MetricField,
): { level?: StatusLevel; tooltip?: string } {
  if (field === "request" || field === "limit") {
    const warnings = podBudgetWarnings(resource, metricResource, field);
    return warnings.length > 0 ? { level: "warning", tooltip: warnings.join("\n") } : {};
  }
  const metrics = resource.object["resourceMetrics"] as
    | Partial<Record<Resource, { used?: number; request?: number; percent?: number }>>
    | undefined;
  const value = metrics?.[metricResource];
  const percent = value?.percent;
  if (
    !value ||
    percent === undefined ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    value.used === undefined ||
    !Number.isFinite(value.used) ||
    value.request === undefined ||
    !Number.isFinite(value.request) ||
    value.request <= 0
  )
    return {};
  return {
    level: percent >= 100 ? "error" : percent >= 80 ? "warning" : "ok",
    tooltip: `${resourceLabel(metricResource)} usage: ${formatMetric(percent, "percentage")} of request (${formatMetric(value.used, metricResource)} / ${formatMetric(value.request, metricResource)}).\nThresholds: warning at 80%, high at 100%. Request is the resource reservation.`,
  };
}
