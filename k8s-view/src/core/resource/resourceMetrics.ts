import { KubeResource } from "./KubeResource";

export const METRICS_GROUP = "metrics.k8s.io";
export const metricRef = (kind: string) => ({ group: METRICS_GROUP, kind: `${kind}Metrics` });

type Resource = "cpu" | "memory";
type Budget = "requests" | "limits";
interface Resources {
  requests?: Partial<Record<Resource, string>>;
  limits?: Partial<Record<Resource, string>>;
}
interface Container {
  name?: string;
  restartPolicy?: string;
  resources?: Resources;
}
interface PodSpec {
  containers?: Container[];
  initContainers?: Container[];
  resources?: Resources;
  overhead?: Partial<Record<Resource, string>>;
  nodeName?: string;
}

/** Kubernetes quantities in cores (CPU) or bytes (memory); never parse a missing value as zero. */
export function parseQuantity(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const m = String(value).match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/);
  if (!m) return undefined;
  const suffix = m[2] ?? "";
  const decimal: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
  };
  const factor = /^[eE][+-]?\d+$/.test(suffix)
    ? 10 ** Number(suffix.slice(1))
    : suffix.endsWith("i")
      ? 1024 ** ("KMGTPE".indexOf(suffix[0]!) + 1)
      : (decimal[suffix] ?? 1);
  const n = Number(m[1]) * factor;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Effective Pod budget, including ordered restartable init sidecars and Pod overhead. */
export function podBudget(pod: KubeResource, resource: Resource, budget: Budget): number | undefined {
  const spec = pod.object["spec"] as PodSpec | undefined;
  if (!spec) return undefined;
  const podLevel = parseQuantity(spec.resources?.[budget]?.[resource]);
  if (podLevel !== undefined) return podLevel + (parseQuantity(spec.overhead?.[resource]) ?? 0);
  let specified = false;
  const amount = (c: Container) => {
    const n = parseQuantity(c.resources?.[budget]?.[resource]);
    if (n !== undefined) specified = true;
    // One unbounded container makes the aggregate limit unbounded.
    return n ?? (budget === "limits" ? Infinity : 0);
  };
  let sidecars = 0;
  let initPeak = 0;
  for (const c of spec.initContainers ?? []) {
    const n = amount(c);
    if (c.restartPolicy === "Always") sidecars += n;
    initPeak = Math.max(initPeak, sidecars + (c.restartPolicy === "Always" ? 0 : n));
  }
  const steady = (spec.containers ?? []).reduce((total, c) => total + amount(c), sidecars);
  const total = Math.max(steady, initPeak);
  return specified && Number.isFinite(total) ? total + (parseQuantity(spec.overhead?.[resource]) ?? 0) : undefined;
}

function sumKnown(values: readonly (number | undefined)[]): number | undefined {
  return values.length > 0 && values.every((v) => v !== undefined)
    ? values.reduce<number>((sum, v) => sum + v!, 0)
    : undefined;
}

export function withResourceMetrics(
  resource: KubeResource,
  metric: KubeResource | undefined,
  nodePods?: readonly KubeResource[],
): KubeResource {
  const isNode = resource.kind.kind === "Node";
  const terminal = ["Succeeded", "Failed"].includes(String((resource.object["status"] as { phase?: string })?.phase));
  const pods = nodePods?.filter(
    (p) =>
      (p.object["spec"] as PodSpec | undefined)?.nodeName === resource.name &&
      !["Succeeded", "Failed"].includes(String((p.object["status"] as { phase?: string })?.phase)),
  );
  const metrics = Object.fromEntries(
    (["cpu", "memory"] as const).map((r) => {
      const usage = metric?.object["usage"] as Record<string, string> | undefined;
      const containers = metric?.object["containers"] as { usage?: Record<string, string> }[] | undefined;
      const used = terminal
        ? undefined
        : isNode
          ? parseQuantity(usage?.[r])
          : sumKnown((containers ?? []).map((c) => parseQuantity(c.usage?.[r])));
      const request = isNode
        ? pods && sumKnown(pods.map((p) => podBudget(p, r, "requests")).filter((v) => v !== undefined))
        : podBudget(resource, r, "requests");
      const limit = isNode
        ? pods && sumKnown(pods.map((p) => podBudget(p, r, "limits")))
        : podBudget(resource, r, "limits");
      return [
        r,
        {
          used,
          request,
          limit,
          percent: used !== undefined && request !== undefined && request > 0 ? (used / request) * 100 : undefined,
        },
      ];
    }),
  );
  return new KubeResource(resource.kind, { ...resource.object, resourceMetrics: metrics });
}

export function formatMetric(n: number, render: "cpu" | "memory" | "percentage"): string {
  const compact = (v: number) => String(Number(v.toFixed(2)));
  if (render === "percentage") return `${compact(n)}%`;
  if (render === "cpu") return n > 0 && n < 1 ? `${compact(n * 1000)}m` : compact(n);
  for (const [unit, scale] of [
    ["E", 1e18],
    ["P", 1e15],
    ["T", 1e12],
    ["G", 1e9],
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    if (n >= scale) return `${compact(n / scale)}${unit}`;
  }
  return `${compact(n)}B`;
}
