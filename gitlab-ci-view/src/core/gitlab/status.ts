export type StatusLevel = "ok" | "warning" | "error" | "progress" | "manual" | "neutral";

const ACTIVE = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "canceling"]);

/** Whether a pipeline/job can still change status without user action. */
export function isActive(status: string): boolean {
  return ACTIVE.has(status);
}

export function statusLevel(status: string, allowFailure = false): StatusLevel {
  switch (status) {
    case "success":
      return "ok";
    case "failed":
      return allowFailure ? "warning" : "error";
    case "manual":
    case "scheduled":
      return "manual";
    default:
      return isActive(status) ? "progress" : "neutral";
  }
}

/** Codicon name; `~spin` is ThemeIcon's spinning suffix (the webview converts it to `codicon-modifier-spin`). */
export function statusIcon(status: string, allowFailure = false): string {
  switch (status) {
    case "success":
      return "pass";
    case "failed":
      return allowFailure ? "warning" : "error";
    case "running":
      return "sync~spin";
    case "created":
    case "pending":
    case "preparing":
    case "waiting_for_resource":
      return "clock";
    case "canceling":
    case "canceled":
      return "circle-slash";
    case "skipped":
      return "debug-step-over";
    case "manual":
      return "gear";
    case "scheduled":
      return "watch";
    default:
      return "circle-outline";
  }
}

export function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}
