import { isActive } from "../gitlab/status";

export type PipelineOutcome = "succeeded" | "failed" | "canceled";

interface PipelineState {
  readonly id: number;
  readonly status: string;
}

/** The same pipeline just transitioned from running to finished → result; otherwise `undefined` (including the initial load). */
export function finishedOutcome(
  prev: PipelineState | undefined,
  next: PipelineState | undefined,
): PipelineOutcome | undefined {
  if (!prev || !next || prev.id !== next.id || !isActive(prev.status)) return undefined;
  switch (next.status) {
    case "success":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return undefined;
  }
}

export function shouldNotify(outcome: PipelineOutcome, mode: "off" | "failed" | "all"): boolean {
  if (mode === "off") return false;
  return mode === "all" || outcome === "failed";
}
