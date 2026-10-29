import type { FilterState, PipelineFilters } from "../core/gitlab/model";
import type { RepoRef } from "./RepoRegistry";

/** UI filters → API parameters for a specific repository. */
export function effectiveFilters(repo: RepoRef, f: FilterState, username: string | undefined): PipelineFilters {
  const refName = f.refName?.trim();
  return {
    ...(refName ? { ref: refName } : f.ref === "current" && repo.branch ? { ref: repo.branch } : {}),
    ...(f.ref === "tags" ? { scope: "tags" as const } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.mine && username ? { username } : {}),
  };
}
