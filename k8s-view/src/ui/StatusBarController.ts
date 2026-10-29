import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { ContextService } from "../app/ContextService";
import { HotkeyService } from "../app/HotkeyService";
import { ResourceSource } from "../app/ports/ResourceSource";
import { Settings } from "../app/ports/Settings";
import { scopeLabel } from "../core/context/ClusterContext";
import { ResourceTablePanels } from "./webview/ResourceTablePanel";

/** `$(server-environment) ctx / ns` (red background for protected contexts) and refresh status. */
@injectable()
export class StatusBarController implements vscode.Disposable {
  private readonly context = vscode.window.createStatusBarItem("k8sView.context", vscode.StatusBarAlignment.Left, 50);
  private readonly refresh = vscode.window.createStatusBarItem("k8sView.refresh", vscode.StatusBarAlignment.Right, 50);
  private readonly hotkeyItem = vscode.window.createStatusBarItem(
    "k8sView.hotkeys",
    vscode.StatusBarAlignment.Right,
    49,
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly contexts = inject(ContextService),
    private readonly source = inject(ResourceSource),
    private readonly settings = inject(Settings),
    private readonly hotkeys = inject(HotkeyService),
    private readonly tables = inject(ResourceTablePanels),
  ) {}

  start(): void {
    this.context.name = "K8s View: Context";
    this.context.command = "k8sView.selectContext";
    this.refresh.name = "K8s View: Refresh";
    this.refresh.command = "k8sView.toggleAutoRefresh";
    this.hotkeyItem.name = "K8s View: Hotkeys";
    this.hotkeyItem.command = "k8sView.toggleHotkeys";
    this.disposables.push(
      this.contexts.onDidChange(() => this.update()),
      this.contexts.onDidChangeStatus(() => this.update()),
      this.source.onDidChangeSummary(() => this.update()),
      this.settings.onDidChange(() => this.update()),
      this.hotkeys.onDidChange(() => this.updateHotkeys()),
      this.tables.onDidChangeActive(() => this.updateHotkeys()),
    );
    this.updateHotkeys();
    this.update();
  }

  update(): void {
    const ctx = this.contexts.current;
    if (!ctx) {
      this.context.text = "$(server-environment) No context";
      this.context.backgroundColor = undefined;
      this.context.tooltip = "K8s View: select a Kubernetes context";
    } else {
      this.context.text = `$(server-environment) ${ctx.name} / ${scopeLabel(ctx.scope)}`;
      this.context.backgroundColor = ctx.isProtected
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : undefined;
      const connection = this.contexts.connection;
      const md = new vscode.MarkdownString("", true);
      md.appendMarkdown(`**K8s View** — \`${ctx.name}\`${ctx.isProtected ? " $(shield) protected" : ""}\n\n`);
      md.appendMarkdown(
        `Cluster: \`${ctx.cluster}\`  \nUser: \`${ctx.user}\`  \nNamespace: ${scopeLabel(ctx.scope)}  \n`,
      );
      if (connection.state === "connected") md.appendMarkdown(`Server: ${connection.serverVersion}`);
      if (connection.state === "error") md.appendMarkdown(`$(error) ${connection.message}`);
      this.context.tooltip = md;
    }
    this.context.show();

    const summary = this.source.summary();
    const mode = this.settings.refreshMode();
    const [icon, label] =
      summary.state === "paused"
        ? ["$(debug-pause)", "paused"]
        : summary.state === "error"
          ? ["$(warning)", "error"]
          : summary.state === "polling" || mode === "poll"
            ? ["$(clock)", "polling"]
            : mode === "manual"
              ? ["$(hand)", "manual"]
              : ["$(pulse)", "live"];
    this.refresh.text = `${icon} K8s View: ${label}`;
    this.refresh.tooltip = `${summary.watches} watch(es)${summary.message ? ` — ${summary.message}` : ""}. Click to ${summary.state === "paused" ? "resume" : "pause"} auto refresh.`;
    this.refresh.backgroundColor =
      summary.state === "error" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.refresh.show();
    void vscode.commands.executeCommand("setContext", "k8sView.paused", this.source.paused);
  }

  /** Show only in table tabs or when mode is ON (as a reminder to turn it off). */
  private updateHotkeys(): void {
    const on = this.hotkeys.enabled;
    this.hotkeyItem.text = `$(keyboard) K8s keys: ${on ? "ON" : "OFF"}`;
    this.hotkeyItem.tooltip = on
      ? "K8s View hotkeys are ON: in the table view they override VS Code keybindings (press ? for the list). Click to turn off."
      : "K8s View hotkeys are OFF. Click to turn on (table view only).";
    this.hotkeyItem.backgroundColor = on ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    if (on || this.tables.tableActive) this.hotkeyItem.show();
    else this.hotkeyItem.hide();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.context.dispose();
    this.refresh.dispose();
    this.hotkeyItem.dispose();
  }
}
