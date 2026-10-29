import { isActive } from "./status";

export interface StageGroup<J> {
  readonly stage: string;
  readonly jobs: J[];
}

/** REST does not return stage order: use each stage's lowest job ID (jobs in earlier stages are created first). */
export function groupByStage<J extends { readonly id: number; readonly stage: string }>(
  jobs: readonly J[],
): StageGroup<J>[] {
  const groups = new Map<string, J[]>();
  for (const job of [...jobs].sort((a, b) => a.id - b.id)) {
    const list = groups.get(job.stage) ?? [];
    list.push(job);
    groups.set(job.stage, list);
  }
  return [...groups].map(([stage, list]) => ({ stage, jobs: list }));
}

/** Aggregate stage status for icon selection. */
export function stageStatus(jobs: readonly { readonly status: string; readonly allowFailure: boolean }[]): string {
  if (jobs.some((j) => j.status === "failed" && !j.allowFailure)) return "failed";
  if (jobs.some((j) => isActive(j.status))) return "running";
  if (jobs.some((j) => j.status === "manual")) return "manual";
  if (jobs.some((j) => j.status === "canceled")) return "canceled";
  if (jobs.length > 0 && jobs.every((j) => j.status === "skipped")) return "skipped";
  return "success";
}
