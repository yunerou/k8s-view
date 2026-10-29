import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Messenger } from "vscode-messenger";
import { LogSession } from "../../app/LogSession";
import { PipelineService } from "../../app/PipelineService";
import { GitLabApi } from "../../app/ports/GitLabApi";
import type { RepoRef } from "../../app/RepoRegistry";
import type { Job } from "../../core/gitlab/model";
import { EXTENSION_CONTEXT } from "../../di/tokens";
import { LOG_VIEW_TYPE, type LogInit, type LogJobInfo, LogNotifications, LogRequests } from "../../shared/protocol";
import { openUrl } from "../commands";
import { webviewHtml, webviewOptions } from "./html";

export function jobInfo(j: Job): LogJobInfo {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    allowFailure: j.allowFailure,
    webUrl: j.webUrl,
    duration: j.duration,
  };
}

/** One log tab per job; reopening an already open job focuses its tab. */
@injectable()
export class LogPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly api = inject(GitLabApi),
    private readonly pipelines = inject(PipelineService),
  ) {}

  open(repo: RepoRef, jobId: number, jobName?: string): void {
    const key = `${repo.id}#${jobId}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const uri = this.extension.extensionUri;
    const title = `${jobName ?? `Job ${jobId}`} · log`;
    const panel = vscode.window.createWebviewPanel(LOG_VIEW_TYPE, title, vscode.ViewColumn.Active, {
      ...webviewOptions(uri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = new vscode.ThemeIcon("output");
    panel.webview.html = webviewHtml(panel.webview, uri, "log", title);
    const session = new LogSession(this.api, this.pipelines, repo, jobId);
    const m = new Messenger();
    const participant = m.registerWebviewPanel(panel);
    const updatePaused = () => session.setPaused(!panel.visible || !vscode.window.state.focused);
    const subs = [
      panel.onDidChangeViewState(updatePaused),
      vscode.window.onDidChangeWindowState(updatePaused),
      m.onRequest(
        LogRequests.getInit,
        (): LogInit => ({
          text: session.content,
          ...(session.job ? { job: jobInfo(session.job) } : {}),
          ...(session.error ? { error: session.error } : {}),
        }),
      ),
      m.onRequest(LogRequests.openUrl, ({ url }) => openUrl(url)),
      session.onAppend((chunk) => m.sendNotification(LogNotifications.append, participant, chunk)),
      session.onStatus((job) => {
        panel.title = `${job.name} · log`;
        m.sendNotification(LogNotifications.status, participant, jobInfo(job));
      }),
      session.onError((message) => m.sendNotification(LogNotifications.error, participant, { message })),
    ];
    panel.onDidDispose(() => {
      session.dispose();
      for (const s of subs) s.dispose();
      this.panels.delete(key);
    });
    this.panels.set(key, panel);
    updatePaused();
    void session.start();
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
  }
}
