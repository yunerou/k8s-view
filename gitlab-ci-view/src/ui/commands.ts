import * as vscode from "vscode";
import { actionErrorMessage } from "../app/errors";
import { editFilters } from "../app/filterFlow";
import type { PipelineService } from "../app/PipelineService";
import type { Poller } from "../app/Poller";
import type { Notifier } from "../app/ports/Notifier";
import type { Prompter } from "../app/ports/Prompter";
import type { Settings } from "../app/ports/Settings";
import type { RepoRegistry } from "../app/RepoRegistry";
import { ALL, type RepoSelection } from "../app/RepoSelection";
import type { RunPipelineFlow } from "../app/RunPipelineFlow";
import type { TokenFlow } from "../app/TokenFlow";
import { type HostTarget, hostTarget } from "../core/remote/remote";
import type { PipelineTreeProvider } from "./tree/PipelineTreeProvider";
import type { TreeNode } from "./tree/TreeNode";
import type { LogPanels } from "./webview/LogPanel";
import type { PipelinePanel } from "./webview/PipelinePanel";

export interface CommandDeps {
  readonly runFlow: RunPipelineFlow;
  readonly panel: PipelinePanel;
  readonly logs: LogPanels;
  readonly repos: RepoRegistry;
  readonly selection: RepoSelection;
  readonly tokenFlow: TokenFlow;
  readonly pipelines: PipelineService;
  readonly poller: Poller;
  readonly tree: PipelineTreeProvider;
  readonly prompter: Prompter;
  readonly notifier: Notifier;
  readonly settings: Settings;
}

type PipelineNode = Extract<TreeNode, { type: "pipeline" }>;
type JobNode = Extract<TreeNode, { type: "job" }>;
type LoadMoreNode = Extract<TreeNode, { type: "loadMore" }>;

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand.bind(vscode.commands);
  return [
    reg("gitlabCiView.openFullView", (arg?: TreeNode | { readonly repoId: string; readonly pipelineId?: number }) => {
      if (arg && "type" in arg) {
        d.panel.open(arg.type === "pipeline" ? { repoId: arg.repo.id, pipelineId: arg.pipeline.id } : undefined);
      } else {
        d.panel.open(arg);
      }
    }),
    reg(
      "gitlabCiView.openLog",
      (arg: JobNode | { readonly repoId: string; readonly jobId: number; readonly jobName?: string }) => {
        if ("type" in arg) {
          d.logs.open(arg.repo, arg.job.id, arg.job.name);
          return;
        }
        const repo = d.repos.get(arg.repoId);
        if (repo) d.logs.open(repo, arg.jobId, arg.jobName);
      },
    ),

    reg("gitlabCiView.selectRepository", () => selectRepository(d)),
    reg("gitlabCiView.filter", () => editFilters(d.prompter, d.selection)),
    reg("gitlabCiView.refresh", () => d.poller.now()),
    reg("gitlabCiView.setToken", (host?: string) =>
      d.tokenFlow.setToken(d.repos.hostTargets(), typeof host === "string" ? targetFor(d, host) : undefined),
    ),
    reg("gitlabCiView.manageTokens", () => d.tokenFlow.manage(d.repos.hostTargets())),
    reg("gitlabCiView.loadMore", (n: LoadMoreNode) => d.tree.loadMore(n.repo)),
    reg("gitlabCiView.retryPipeline", (n: PipelineNode) =>
      runAction(d, `Retried pipeline #${n.pipeline.id}`, () => d.pipelines.retryPipeline(n.repo, n.pipeline.id)),
    ),
    reg("gitlabCiView.cancelPipeline", (n: PipelineNode) =>
      runAction(d, `Canceled pipeline #${n.pipeline.id}`, () => d.pipelines.cancelPipeline(n.repo, n.pipeline.id)),
    ),
    reg("gitlabCiView.retryJob", (n: JobNode) =>
      runAction(d, `Retried ${n.job.name}`, () => d.pipelines.retryJob(n.repo, n.job.id)),
    ),
    reg("gitlabCiView.cancelJob", (n: JobNode) =>
      runAction(d, `Canceled ${n.job.name}`, () => d.pipelines.cancelJob(n.repo, n.job.id)),
    ),
    reg("gitlabCiView.playJob", (n: JobNode) => d.runFlow.play(n.repo, n.job)),
    reg("gitlabCiView.runPipeline", (n?: TreeNode) => d.runFlow.run(n?.type === "repo" ? n.repo : undefined)),
    reg("gitlabCiView.openInBrowser", (n: PipelineNode | JobNode) =>
      openUrl(n.type === "job" ? n.job.webUrl : n.pipeline.webUrl),
    ),
  ];
}

function targetFor(d: CommandDeps, host: string): HostTarget {
  return d.repos.hostTargets().find((t) => t.host === host) ?? hostTarget(host, d.settings.hosts());
}

async function selectRepository(d: CommandDeps): Promise<void> {
  const repos = d.repos.repos();
  const picked = await d.prompter.pick(
    [
      { label: "$(list-flat) All repositories", description: `${repos.length} repositories`, value: ALL },
      ...repos.map((r) => ({
        label: `$(repo) ${r.name}`,
        description: r.projectPath,
        detail: r.branch ? `${r.host} · ${r.branch}` : r.host,
        value: r.id,
      })),
    ],
    { title: "Show pipelines of", placeholder: "Repository" },
  );
  if (picked !== undefined) await d.selection.select(picked);
}

/** Run a GitLab action, refresh immediately afterward, and show a clear error on failure. */
export async function runAction(
  d: Pick<CommandDeps, "poller" | "notifier">,
  done: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
    d.poller.now();
    vscode.window.setStatusBarMessage(`$(check) ${done}`, 3000);
  } catch (e) {
    await d.notifier.error(actionErrorMessage(e));
  }
}

/** Open only HTTP(S) links (API URLs are not fully trusted). */
export function openUrl(url: string): void {
  if (/^https?:\/\//i.test(url)) void vscode.env.openExternal(vscode.Uri.parse(url));
}
