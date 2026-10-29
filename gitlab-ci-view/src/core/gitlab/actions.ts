import { isActive } from "./status";

export type PipelineAction = "retry" | "cancel";
export type JobAction = "play" | "retry" | "cancel";

export function pipelineActions(status: string): PipelineAction[] {
  if (status === "failed" || status === "canceled") return ["retry"];
  if (isActive(status) && status !== "canceling") return ["cancel"];
  return [];
}

export function jobActions(status: string): JobAction[] {
  if (status === "manual") return ["play"];
  if (isActive(status)) return status === "canceling" ? [] : ["cancel"];
  if (status === "success" || status === "failed" || status === "canceled") return ["retry"];
  return [];
}
