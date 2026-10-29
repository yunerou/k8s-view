import type { FullViewState, JobRow, PipelineDetail, PipelineRow } from "../../../src/shared/protocol";

export function row(patch: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id: 1,
    iid: 1,
    status: "success",
    ref: "main",
    sha: "abc1234",
    source: "push",
    tag: false,
    createdAt: "2026-10-29T10:00:00Z",
    webUrl: "https://gitlab.com/team/web/-/pipelines/1",
    actions: [],
    ...patch,
  };
}

export function fullState(patch: Partial<FullViewState> = {}): FullViewState {
  return {
    repos: [
      { id: "w", name: "web", host: "gitlab.com", projectPath: "team/web", branch: "main", token: "ok" },
      { id: "o", name: "ops", host: "git.company.vn", projectPath: "team/ops", branch: "main", token: "missing" },
    ],
    selection: "all",
    filters: { ref: "current", status: "", source: "", mine: false },
    sections: [
      { repoId: "o", page: 1, hasNext: false, loading: false, rows: [] },
      {
        repoId: "w",
        page: 1,
        hasNext: true,
        loading: false,
        rows: [
          row({ id: 101, status: "running", actions: ["cancel"] }),
          row({ id: 100, status: "failed", actions: ["retry"] }),
        ],
      },
    ],
    now: Date.parse("2026-10-29T10:10:00Z"),
    ...patch,
  };
}

export function jobRow(patch: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    name: "build",
    stage: "build",
    status: "success",
    allowFailure: false,
    duration: 65,
    webUrl: "https://gitlab.com/team/web/-/jobs/1",
    actions: ["retry"],
    ...patch,
  };
}

export function detail(patch: Partial<PipelineDetail> = {}): PipelineDetail {
  return {
    repoId: "w",
    pipelineId: 101,
    pipeline: row({ id: 101, status: "running", actions: ["cancel"] }),
    tab: "jobs",
    stages: [
      { stage: "build", jobs: [jobRow()] },
      {
        stage: "deploy",
        jobs: [
          jobRow({ id: 3, name: "prod", stage: "deploy", status: "manual", duration: undefined, actions: ["play"] }),
        ],
      },
    ],
    loading: false,
    ...patch,
  };
}
