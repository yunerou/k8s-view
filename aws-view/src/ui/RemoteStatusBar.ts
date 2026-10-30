import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { IdleReminder } from "../app/IdleReminder";
import { instanceLabel } from "../core/ec2/model";
import { formatDuration } from "../core/util/format";

/** In the Remote window of an instance: `$(vm-running) box · 2h 15m`, click to stop or snooze. */
@injectable()
export class RemoteStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("awsView.remote", vscode.StatusBarAlignment.Left, 29);
  private readonly subs: { dispose(): unknown }[] = [];

  constructor(private readonly reminder = inject(IdleReminder)) {}

  start(): void {
    this.item.name = "AWS View: Remote instance";
    this.subs.push(this.reminder.onDidChange(() => this.update()));
    this.update();
  }

  update(): void {
    const status = this.reminder.remoteStatus();
    if (!status) {
      this.item.hide();
      return;
    }
    const label = instanceLabel(status.instance);
    this.item.text =
      status.uptimeMs === undefined
        ? `$(vm) ${label} · ${status.instance.state}`
        : `$(vm-running) ${label} · ${formatDuration(status.uptimeMs)}`;
    this.item.tooltip = `AWS View: ${label} (${status.instance.id}). Click to stop it or snooze the reminder.`;
    this.item.command = "awsView.remoteActions";
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.item.dispose();
  }
}
