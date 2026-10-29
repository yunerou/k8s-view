import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Messenger } from "vscode-messenger";
import { actionErrorMessage } from "../../app/errors";
import { FullViewModel } from "../../app/FullViewModel";
import { PipelineService } from "../../app/PipelineService";
import { Poller } from "../../app/Poller";
import { Notifier } from "../../app/ports/Notifier";
import { RepoRegistry } from "../../app/RepoRegistry";
import { RepoSelection } from "../../app/RepoSelection";
import { RunPipelineFlow } from "../../app/RunPipelineFlow";
import { EXTENSION_CONTEXT } from "../../di/tokens";
import { type ActionTarget, FULL_VIEW_TYPE, FullViewNotifications, FullViewRequests } from "../../shared/protocol";
import { openUrl } from "../commands";
import { webviewHtml, webviewOptions } from "./html";

/** Full view: a single editor tab; state lives in `FullViewModel`. */
@injectable()
export class PipelinePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: { dispose(): unknown }[] = [];

  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly model = inject(FullViewModel),
    private readonly repos = inject(RepoRegistry),
    private readonly selection = inject(RepoSelection),
    private readonly pipelines = inject(PipelineService),
    private readonly runFlow = inject(RunPipelineFlow),
    private readonly poller = inject(Poller),
    private readonly notifier = inject(Notifier),
  ) {}

  open(target?: { readonly repoId: string; readonly pipelineId?: number }): void {
    if (this.panel) this.panel.reveal();
    else this.create();
    if (target?.pipelineId !== undefined) void this.model.open(target.repoId, target.pipelineId);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private create(): void {
    const uri = this.extension.extensionUri;
    const panel = vscode.window.createWebviewPanel(FULL_VIEW_TYPE, "GitLab CI", vscode.ViewColumn.Active, {
      ...webviewOptions(uri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = new vscode.ThemeIcon("rocket");
    panel.webview.html = webviewHtml(panel.webview, uri, "pipeline", "GitLab CI");
    const m = new Messenger();
    const participant = m.registerWebviewPanel(panel);
    this.disposables = [
      m.onRequest(FullViewRequests.getState, () => this.model.state()),
      m.onRequest(FullViewRequests.select, ({ selection }) => this.selection.select(selection)),
      m.onRequest(FullViewRequests.setFilters, ({ filters }) => this.selection.setFilters(filters)),
      m.onRequest(FullViewRequests.setPage, ({ repoId, page }) => this.model.setPage(repoId, page)),
      m.onRequest(FullViewRequests.openPipeline, ({ repoId, pipelineId }) => this.model.open(repoId, pipelineId)),
      m.onRequest(FullViewRequests.closePipeline, () => this.model.close()),
      m.onRequest(FullViewRequests.setTab, ({ tab }) => this.model.setTab(tab)),
      m.onRequest(FullViewRequests.action, (target) => this.act(target)),
      m.onRequest(FullViewRequests.runPipeline, async ({ repoId }) => {
        const repo = this.repos.get(repoId);
        if (repo && (await this.runFlow.run(repo))) await this.model.refresh();
      }),
      m.onRequest(FullViewRequests.openLog, (params) => {
        void vscode.commands.executeCommand("gitlabCiView.openLog", params);
      }),
      m.onRequest(FullViewRequests.openUrl, ({ url }) => openUrl(url)),
      m.onRequest(FullViewRequests.setToken, ({ host }) => {
        void vscode.commands.executeCommand("gitlabCiView.setToken", host);
      }),
      m.onRequest(FullViewRequests.refresh, async () => {
        await this.model.refresh();
      }),
      this.model.onDidChange((state) => m.sendNotification(FullViewNotifications.state, participant, state)),
      panel.onDidChangeViewState(() => {
        this.model.setVisible(panel.visible);
        if (panel.visible) this.poller.now();
      }),
      panel.onDidDispose(() => this.onDisposed()),
    ];
    this.panel = panel;
    this.model.setVisible(true);
    void this.model.refresh();
  }

  private onDisposed(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.panel = undefined;
    this.model.setVisible(false);
    this.model.close();
  }

  private async act(t: ActionTarget): Promise<void> {
    const repo = this.repos.get(t.repoId);
    if (!repo) return;
    try {
      if (t.kind === "pipeline") {
        if (t.action === "retry") await this.pipelines.retryPipeline(repo, t.pipelineId);
        else await this.pipelines.cancelPipeline(repo, t.pipelineId);
      } else if (t.action === "play") {
        await this.runFlow.play(repo, { id: t.jobId, name: t.jobName });
      } else if (t.action === "retry") {
        await this.pipelines.retryJob(repo, t.jobId);
      } else {
        await this.pipelines.cancelJob(repo, t.jobId);
      }
    } catch (e) {
      await this.notifier.error(actionErrorMessage(e));
    }
    await this.model.refresh();
    this.poller.now();
  }
}
