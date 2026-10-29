/**
 * Typed protocol between the extension and webview (vscode-messenger). Shared by `src/` and `webview-ui/`;
 * contains only types and constants, with no `vscode` imports.
 */
import type { NotificationType, RequestType } from "vscode-messenger-common";
import type { DagLayout } from "../core/dag/layout";
import type { JobAction, PipelineAction } from "../core/gitlab/actions";
import type { FilterState } from "../core/gitlab/model";

export interface RepoInfo {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly projectPath: string;
  readonly branch: string | undefined;
  readonly token: "ok" | "missing" | "invalid";
}

export interface PipelineRow {
  readonly id: number;
  readonly iid: number;
  readonly status: string;
  readonly ref: string;
  readonly sha: string;
  readonly source: string | undefined;
  readonly tag?: boolean;
  readonly createdAt: string;
  readonly webUrl: string;
  readonly actions: readonly PipelineAction[];
}

export interface RepoSection {
  readonly repoId: string;
  readonly page: number;
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly rows: readonly PipelineRow[];
  readonly error?: string;
}

export interface JobRow {
  readonly id: number;
  readonly name: string;
  readonly stage: string;
  readonly status: string;
  readonly allowFailure: boolean;
  readonly duration: number | undefined;
  readonly webUrl: string;
  readonly actions: readonly JobAction[];
}

export type DetailTab = "jobs" | "dag";

export interface PipelineDetail {
  readonly repoId: string;
  readonly pipelineId: number;
  /** `undefined` during the initial load. */
  readonly pipeline: PipelineRow | undefined;
  readonly tab: DetailTab;
  readonly stages: readonly { readonly stage: string; readonly jobs: readonly JobRow[] }[];
  readonly dag?: { readonly layout: DagLayout; readonly fallback: boolean; readonly error?: string };
  readonly loading: boolean;
  readonly error?: string;
}

export interface FullViewState {
  readonly repos: readonly RepoInfo[];
  /** `"all"` or a repository ID. */
  readonly selection: string;
  readonly filters: FilterState;
  readonly sections: readonly RepoSection[];
  readonly detail?: PipelineDetail;
  /** Timestamp used by the webview to calculate "5m ago". */
  readonly now: number;
}

export type ActionTarget =
  | { readonly kind: "pipeline"; readonly repoId: string; readonly pipelineId: number; readonly action: PipelineAction }
  | {
      readonly kind: "job";
      readonly repoId: string;
      readonly jobId: number;
      readonly jobName: string;
      readonly action: JobAction;
    };

export const FullViewRequests = {
  getState: { method: "full/getState" } as RequestType<void, FullViewState>,
  select: { method: "full/select" } as RequestType<{ selection: string }, void>,
  setFilters: { method: "full/setFilters" } as RequestType<{ filters: FilterState }, void>,
  setPage: { method: "full/setPage" } as RequestType<{ repoId: string; page: number }, void>,
  openPipeline: { method: "full/openPipeline" } as RequestType<{ repoId: string; pipelineId: number }, void>,
  closePipeline: { method: "full/closePipeline" } as RequestType<void, void>,
  setTab: { method: "full/setTab" } as RequestType<{ tab: DetailTab }, void>,
  action: { method: "full/action" } as RequestType<ActionTarget, void>,
  runPipeline: { method: "full/runPipeline" } as RequestType<{ repoId: string }, void>,
  openLog: { method: "full/openLog" } as RequestType<{ repoId: string; jobId: number; jobName: string }, void>,
  openUrl: { method: "full/openUrl" } as RequestType<{ url: string }, void>,
  setToken: { method: "full/setToken" } as RequestType<{ host: string }, void>,
  refresh: { method: "full/refresh" } as RequestType<void, void>,
};

export const FullViewNotifications = {
  /** Extension → webview: complete state (small enough to resend in full). */
  state: { method: "full/state" } as NotificationType<FullViewState>,
};

export const FULL_VIEW_TYPE = "gitlabCiView.full";

// ───────────────────────── Log job ─────────────────────────

export interface LogJobInfo {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly allowFailure: boolean;
  readonly webUrl: string;
  readonly duration: number | undefined;
}

export interface LogInit {
  /** All logs received up to the time of the response. */
  readonly text: string;
  readonly job?: LogJobInfo;
  readonly error?: string;
}

export const LogRequests = {
  getInit: { method: "log/getInit" } as RequestType<void, LogInit>,
  openUrl: { method: "log/openUrl" } as RequestType<{ url: string }, void>,
};

export const LogNotifications = {
  /** `start` = log length (characters) before this chunk: the webview skips chunks already included in `getInit`. */
  append: { method: "log/append" } as NotificationType<{ start: number; text: string }>,
  status: { method: "log/status" } as NotificationType<LogJobInfo>,
  error: { method: "log/error" } as NotificationType<{ message: string }>,
};

export const LOG_VIEW_TYPE = "gitlabCiView.log";
