/** Pipeline API `status` filter values (used by Quick Pick and the Full view toolbar). */
export const PIPELINE_STATUSES: readonly string[] = [
  "running",
  "pending",
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
];

/** Pipeline API `source` filter values. */
export const PIPELINE_SOURCES: readonly string[] = [
  "push",
  "web",
  "merge_request_event",
  "schedule",
  "trigger",
  "api",
  "pipeline",
  "parent_pipeline",
];

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  push: "Push",
  web: "Run manually",
  merge_request_event: "Merge request",
  schedule: "Schedule",
  trigger: "Trigger token",
  api: "API",
  pipeline: "Multi-project pipeline",
  parent_pipeline: "Child pipeline",
};

export function sourceLabel(source: string | undefined): string {
  return source ? (SOURCE_LABELS[source] ?? source.replaceAll("_", " ")) : "Unknown event";
}

/** Determine tag/branch only from GitLab metadata; do not infer it from the ref name. */
export function pipelineEvent(p: { readonly source: string | undefined; readonly tag?: boolean }): string {
  const label = sourceLabel(p.source);
  if (p.source === "merge_request_event") return label;
  if (p.tag === true) return `${label} · Tag`;
  if (p.tag === false) return `${label} · Branch`;
  return label;
}
