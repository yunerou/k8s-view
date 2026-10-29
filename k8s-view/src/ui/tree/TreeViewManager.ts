import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { ContextService } from "../../app/ContextService";
import { StateStore } from "../../app/ports/StateStore";
import { ViewSessionManager } from "../../app/ViewSessionManager";
import { PortForwardManager } from "../PortForwardManager";
import { ResourceTreeProvider } from "./ResourceTreeProvider";
import type { TreeNode } from "./TreeNode";

export const TREE_VIEW_ID = "k8sView.view";
const ACTIVE_VIEW_KEY = "k8sView.activeView";

/**
 * A single sidebar tree shows the selected view (switched via `k8sView.switchView`). Only this view acquires leases,
 * so only its kinds are watched; the selected view is persisted per workspace.
 */
@injectable()
export class TreeViewManager implements vscode.Disposable {
  private readonly provider: ResourceTreeProvider;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessions = inject(ViewSessionManager),
    private readonly contexts = inject(ContextService),
    private readonly state = inject(StateStore),
    portForwards = inject(PortForwardManager),
  ) {
    this.provider = new ResourceTreeProvider(this.sessions, undefined, portForwards);
    this.treeView = vscode.window.createTreeView<TreeNode>(TREE_VIEW_ID, {
      treeDataProvider: this.provider,
      showCollapseAll: true,
      canSelectMany: true,
    });
  }

  start(): void {
    this.disposables.push(
      this.treeView.onDidCollapseElement((e) => this.provider.collapsed(e.element)),
      this.treeView.onDidChangeVisibility(() => this.updateVisibility()),
      this.provider.onDidChangeErrorCount((n) => {
        this.treeView.badge = n > 0 ? { value: n, tooltip: vscode.l10n.t("{0} resources in error", n) } : undefined;
      }),
      this.sessions.onDidChangeSessions(() => this.assign()),
      this.contexts.onDidChange(() => this.updateMessage()),
      this.contexts.onDidChangeStatus(() => this.updateMessage()),
    );
    this.assign();
  }

  /** View currently displayed in the sidebar. */
  get activeViewId(): string | undefined {
    return this.provider.viewId;
  }

  /** Unknown IDs (newly created views, config not yet reloaded) are retained and selected automatically when the view appears. */
  async setActiveView(viewId: string): Promise<void> {
    await this.state.setWorkspace(ACTIVE_VIEW_KEY, viewId);
    this.assign();
  }

  refreshAll(): void {
    this.provider.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.treeView.dispose();
    this.provider.dispose();
  }

  /** Remembered view if still available; otherwise the first view (Workload). */
  private assign(): void {
    const views = this.sessions.all();
    const remembered = this.state.getWorkspace<string>(ACTIVE_VIEW_KEY);
    const session = views.find((s) => s.definition.id === remembered) ?? views[0];
    const previous = this.provider.viewId;
    const next = session?.definition.id;
    if (previous !== next && previous) this.sessions.setTreeVisible(previous, false);
    this.provider.setView(next);
    this.treeView.title = session?.definition.title ?? vscode.l10n.t("View");
    // View-specific title buttons (e.g. "Change kind" for Single resource kind).
    void vscode.commands.executeCommand("setContext", "k8sView.activeView", next ?? "");
    this.updateVisibility();
    this.updateMessage();
  }

  private updateVisibility(): void {
    const viewId = this.provider.viewId;
    if (viewId) this.sessions.setTreeVisible(viewId, this.treeView.visible);
  }

  private updateMessage(): void {
    const ctx = this.contexts.current;
    const connection = this.contexts.connection;
    const loadError = this.contexts.loadError();
    let message: string | undefined;
    if (loadError) message = loadError;
    else if (!ctx) message = vscode.l10n.t("No Kubernetes context found. Check your kubeconfig.");
    else if (connection.state === "error")
      message = vscode.l10n.t("Cannot connect to {0}: {1}", ctx.name, connection.message);
    this.treeView.message = message ?? "";
  }
}
