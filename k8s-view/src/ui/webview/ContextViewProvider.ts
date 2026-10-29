import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Messenger } from "vscode-messenger";
import { ContextService, errorMessage } from "../../app/ContextService";
import { ResourceSource } from "../../app/ports/ResourceSource";
import { Settings } from "../../app/ports/Settings";
import { isProtectedContext } from "../../core/context/ClusterContext";
import { EXTENSION_CONTEXT } from "../../di/tokens";
import { ContextNotifications, type ContextPanelState, ContextRequests } from "../../shared/protocol";
import { webviewHtml, webviewOptions } from "./html";

export const CONTEXT_VIEW_ID = "k8sView.context";

/** Context panel: cluster/namespace selection, connection and watch status, auto-refresh (snippets have a separate section). */
@injectable()
export class ContextViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly messenger = new Messenger({ ignoreHiddenViews: false });
  private view: vscode.WebviewView | undefined;
  private participant: ReturnType<Messenger["registerWebviewView"]> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly contexts = inject(ContextService),
    private readonly source = inject(ResourceSource),
    private readonly settings = inject(Settings),
  ) {
    const m = this.messenger;
    this.disposables.push(
      m.onRequest(ContextRequests.getState, () => this.state()),
      m.onRequest(ContextRequests.pickContext, () =>
        this.guard(async () => {
          await vscode.commands.executeCommand("k8sView.selectContext", { namespaceStep: false });
        }),
      ),
      m.onRequest(ContextRequests.selectNamespace, ({ scope }) =>
        this.guard(() => this.contexts.selectNamespace(scope)),
      ),
      m.onRequest(ContextRequests.refreshNamespaces, () =>
        this.guard(() => this.contexts.loadNamespaces().then(() => undefined)),
      ),
      m.onRequest(ContextRequests.reconnect, () =>
        this.guard(async () => {
          await vscode.commands.executeCommand("k8sView.reconnect");
        }),
      ),
      m.onRequest(ContextRequests.cancelConnection, () => this.contexts.cancelConnection()),
      m.onRequest(ContextRequests.setRefresh, ({ value }) =>
        this.guard(async () => {
          if (value === "pause") {
            this.source.setPaused(true);
            return;
          }
          await (value === "watch" ? this.settings.setRefresh("watch") : this.settings.setRefresh("poll", value));
          this.source.setPaused(false);
        }),
      ),
      this.contexts.onDidChange(() => this.push()),
      this.contexts.onDidChangeStatus(() => this.push()),
      this.source.onDidChangeSummary(() => this.push()),
      this.settings.onDidChange(() => this.push()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extension.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.extension.extensionUri, "context", "K8s View: Context");
    this.participant = this.messenger.registerWebviewView(view);
    view.onDidDispose(() => {
      this.view = undefined;
      this.participant = undefined;
    });
  }

  state(): ContextPanelState {
    const ctx = this.contexts.current;
    const kubeconfigCurrent = this.contexts.kubeconfigCurrentContext();
    const connection = this.contexts.connection;
    const loadError = this.contexts.loadError();
    return {
      contexts: this.contexts.contexts().map((c) => ({
        name: c.name,
        cluster: c.cluster,
        user: c.user,
        isKubeconfigCurrent: c.name === kubeconfigCurrent,
        isProtected: isProtectedContext(c.name, this.settings.protectedContexts()),
      })),
      selected: ctx?.name,
      scope: ctx?.scope,
      namespaces: this.contexts.namespaces.items,
      namespacesForbidden: this.contexts.namespaces.forbidden,
      connection,
      watch: this.source.summary(),
      autoRefresh: !this.source.paused,
      refreshMode: this.settings.refreshMode(),
      pollIntervalSeconds: this.settings.pollIntervalSeconds(),
      ...(loadError ? { loadError } : {}),
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private push(): void {
    if (this.view && this.participant)
      this.messenger.sendNotification(ContextNotifications.state, this.participant, this.state());
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      void vscode.window.showErrorMessage(errorMessage(e));
    }
    this.push();
  }
}
