import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { StateStore } from "../../app/ports/StateStore";
import { ViewSessionManager } from "../../app/ViewSessionManager";

export const TREE_VIEW_ID = "k8sView.view";
const ACTIVE_VIEW_KEY = "k8sView.activeView";

/** Sidebar launcher: resource data is loaded only by editor tabs. */
@injectable()
export class TreeViewManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly treeView: vscode.TreeView<string>;
  private readonly disposables: vscode.Disposable[] = [];
  constructor(
    private readonly sessions = inject(ViewSessionManager),
    private readonly state = inject(StateStore),
  ) {
    this.treeView = vscode.window.createTreeView(TREE_VIEW_ID, {
      treeDataProvider: {
        onDidChangeTreeData: this.changed.event,
        getChildren: () => this.sessions.all().map((s) => s.definition.id),
        getTreeItem: (id: string) => {
          const definition = this.sessions.session(id)!.definition;
          const item = new vscode.TreeItem(definition.title);
          item.iconPath = new vscode.ThemeIcon(definition.icon ?? "table");
          item.command = { command: "k8sView.openTable", title: definition.title, arguments: [id] };
          return item;
        },
      },
    });
  }
  start(): void {
    this.disposables.push(this.sessions.onDidChangeSessions(() => this.changed.fire()));
    this.changed.fire();
  }
  get activeViewId(): string | undefined {
    return this.state.getWorkspace<string>(ACTIVE_VIEW_KEY) ?? this.sessions.all()[0]?.definition.id;
  }
  async setActiveView(viewId: string): Promise<void> {
    await this.state.setWorkspace(ACTIVE_VIEW_KEY, viewId);
    await vscode.commands.executeCommand("k8sView.openTable", viewId);
  }
  refreshAll(): void {
    this.changed.fire();
  }
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.treeView.dispose();
    this.changed.dispose();
  }
}
