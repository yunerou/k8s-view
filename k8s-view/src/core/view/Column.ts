import type { ColumnConfig, RenderKind, StatusLevel } from "../config/schema";
import type { CompiledPath, CompiledTemplate, ExpressionEngine } from "../expression/ExpressionEngine";
import { RESOURCE_VARIABLES, resourceContext } from "../expression/variables";
import { formatAge, formatQuantity } from "../resource/format";
import type { KubeResource } from "../resource/KubeResource";
import { type MetricField, metricAlert } from "../resource/resourceAlerts";
import { formatMetric } from "../resource/resourceMetrics";
import { slug } from "./merge";

/** Cell value: display text, sort key, and extra UI data (status color, timestamp for automatic Age calculation). */
export interface Cell {
  readonly text: string;
  readonly sort: string | number | null;
  readonly level?: StatusLevel;
  readonly tooltip?: string;
  /** `age` renderer: the UI recalculates age from the timestamp without rebuilding the model. */
  readonly timestamp?: number;
  readonly badges?: readonly string[];
}

const OK = /^(true|ready|running|succeeded|completed?|bound|active|healthy|available|ok)$/i;
const ERROR = /^(false|failed|error|lost|unhealthy)$|BackOff|ErrImage/i;
const PROGRESS = /^(unknown|pending|progressing|containercreating|terminating|reconciling)$/i;

export function levelOfText(text: string): StatusLevel {
  if (OK.test(text)) return "ok";
  if (ERROR.test(text)) return "error";
  if (PROGRESS.test(text)) return "progress";
  return "unknown";
}

export class ColumnDefinition {
  readonly id: string;
  readonly title: string;
  readonly render: RenderKind;
  readonly width: number | undefined;
  readonly hidden: boolean;
  readonly usesMetrics: boolean;
  private readonly defaultText: string;
  private readonly metric: { resource: "cpu" | "memory"; field: MetricField } | undefined;
  private readonly path: CompiledPath | undefined;
  private readonly template: CompiledTemplate | undefined;

  constructor(config: ColumnConfig, engine: ExpressionEngine) {
    this.id = config.id ?? slug(config.title);
    this.title = config.title;
    this.render = config.render;
    this.width = config.width;
    this.hidden = config.hidden;
    this.usesMetrics = "path" in config && config.path.startsWith("$.resourceMetrics.");
    const metric =
      "path" in config
        ? config.path.match(/^\$\.resourceMetrics\.(cpu|memory)\.(used|percent|request|limit)$/)
        : undefined;
    this.metric = metric ? { resource: metric[1] as "cpu" | "memory", field: metric[2] as MetricField } : undefined;
    this.defaultText = config.default ?? "";
    if ("path" in config) this.path = engine.compilePath(config.path);
    else this.template = engine.compileTemplate(config.template, { variables: RESOURCE_VARIABLES });
  }

  get sourceKey(): "path" | "template" {
    return this.path ? "path" : "template";
  }

  evaluate(resource: KubeResource, now: number): Cell {
    const cell = this.evaluateValue(resource, now);
    return this.metric ? { ...cell, ...metricAlert(resource, this.metric.resource, this.metric.field) } : cell;
  }

  private evaluateValue(resource: KubeResource, now: number): Cell {
    const values = this.path
      ? this.path.all(resource.object).filter((v) => v !== undefined && v !== null)
      : [this.template!.render(resourceContext(resource))].filter((v) => v !== "");
    if (values.length === 0) return { text: this.defaultText, sort: null };
    const first = values[0];
    switch (this.render) {
      case "age": {
        const ts = typeof first === "string" ? Date.parse(first) : Number.NaN;
        if (Number.isNaN(ts)) return { text: this.defaultText, sort: null };
        return { text: formatAge(now - ts), sort: ts, timestamp: ts };
      }
      case "status": {
        const text = joined(values);
        return { text, sort: text, level: levelOfText(text) };
      }
      case "boolean": {
        const b = first === true || first === "true" || first === "True";
        return { text: b ? "Yes" : "No", sort: b ? 1 : 0 };
      }
      case "count": {
        const n = this.path ? this.path.count(resource.object) : Number(first) || 0;
        return { text: String(n), sort: n };
      }
      case "labels": {
        const obj = typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : {};
        const badges = Object.entries(obj).map(([k, v]) => `${k}=${String(v)}`);
        return { text: badges.join(", "), sort: badges.join(","), badges };
      }
      case "cpu":
      case "memory":
      case "percentage": {
        const n = Number(first);
        return Number.isFinite(n)
          ? { text: formatMetric(n, this.render), sort: n }
          : { text: this.defaultText, sort: null };
      }
      case "quantity": {
        const text = values.map((v) => formatQuantity(String(v))).join(", ");
        return { text, sort: text };
      }
      case "badge": {
        const badges = values.flatMap((v) => (Array.isArray(v) ? v.map(String) : [scalar(v)]));
        return { text: badges.join(", "), sort: badges.join(","), badges };
      }
      default: {
        const text = joined(values);
        const n = values.length === 1 && typeof first === "number" ? first : undefined;
        return { text, sort: n ?? text };
      }
    }
  }
}

function scalar(v: unknown): string {
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function joined(values: unknown[]): string {
  return values.map((v) => (Array.isArray(v) ? v.map(scalar).join(", ") : scalar(v))).join(", ");
}
