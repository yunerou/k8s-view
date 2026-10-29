import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { ContextService } from "./ContextService";
import { ResourceSource } from "./ports/ResourceSource";
import { Settings } from "./ports/Settings";
import { ViewRegistry } from "./ViewRegistry";
import { ViewSession } from "./ViewSession";

/** One ViewSession per registered view; the tree and table for a view share a session (and leases). */
@injectable()
export class ViewSessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, ViewSession>();
  private readonly visibility = new Map<string, { tree: boolean; table: boolean }>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** View (session) list changed after config reload. */
  readonly onDidChangeSessions = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly registry = inject(ViewRegistry),
    private readonly contexts = inject(ContextService),
    private readonly source = inject(ResourceSource),
    private readonly settings = inject(Settings),
  ) {
    this.subscription = registry.onDidChange(() => this.sync());
    this.sync();
  }

  session(viewId: string): ViewSession | undefined {
    return this.sessions.get(viewId);
  }

  all(): ViewSession[] {
    return this.registry.views().flatMap((v) => this.sessions.get(v.id) ?? []);
  }

  setTreeVisible(viewId: string, visible: boolean): void {
    this.setVisibility(viewId, { tree: visible });
  }

  setTableVisible(viewId: string, visible: boolean): void {
    this.setVisibility(viewId, { table: visible });
  }

  dispose(): void {
    this.subscription.dispose();
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.changed.dispose();
  }

  private setVisibility(viewId: string, patch: Partial<{ tree: boolean; table: boolean }>): void {
    const v = { ...(this.visibility.get(viewId) ?? { tree: false, table: false }), ...patch };
    this.visibility.set(viewId, v);
    this.sessions.get(viewId)?.setVisible(v.tree || v.table);
  }

  private sync(): void {
    const views = this.registry.views();
    const ids = new Set(views.map((v) => v.id));
    for (const [id, session] of this.sessions) {
      if (!ids.has(id)) {
        session.dispose();
        this.sessions.delete(id);
      }
    }
    for (const view of views) {
      const existing = this.sessions.get(view.id);
      if (existing) {
        if (existing.view !== view) existing.update(view);
        continue;
      }
      const session = new ViewSession(view, this.contexts, this.source, this.settings);
      const v = this.visibility.get(view.id);
      if (v) session.setVisible(v.tree || v.table);
      this.sessions.set(view.id, session);
    }
    this.changed.fire();
  }
}
