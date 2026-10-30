import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { AuthService } from "../app/AuthService";
import { kindLabel } from "../core/aws/profiles";
import { formatDuration } from "../core/util/format";

/** Below this, the session item turns yellow. */
const WARN_MS = 15 * 60_000;

/** `$(cloud) profile · 7h 12m left`: click to switch profile or sign in. */
@injectable()
export class StatusBarController implements vscode.Disposable {
  private readonly authItem = vscode.window.createStatusBarItem("awsView.auth", vscode.StatusBarAlignment.Left, 30);
  private readonly subs: { dispose(): unknown }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly auth = inject(AuthService),
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    this.authItem.name = "AWS View: Profile";
    this.subs.push(this.auth.onDidChange(() => this.update()));
    this.timer = setInterval(() => this.update(), 60_000);
    this.update();
  }

  update(): void {
    const item = this.authItem;
    const s = this.auth.state();
    item.backgroundColor = undefined;
    switch (s.status) {
      case "noProfile":
        item.text = "$(cloud) AWS: select profile";
        item.tooltip = "AWS View: select an AWS profile";
        item.command = "awsView.selectProfile";
        break;
      case "signedOut":
        item.text = `$(cloud) ${s.profile.name} · signed out`;
        item.tooltip = `AWS View: sign in to ${s.profile.name}`;
        item.command = "awsView.signIn";
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "signedIn": {
        const left = s.expiresAt === undefined ? undefined : s.expiresAt - this.now();
        item.text =
          left === undefined
            ? `$(cloud) ${s.profile.name}`
            : `$(cloud) ${s.profile.name} · ${formatDuration(left)} left`;
        item.tooltip = `AWS View: ${s.profile.name} (${kindLabel(s.profile.kind)})${
          left === undefined ? "" : `, session ends in ${formatDuration(left)}`
        }. Click to switch profile.`;
        item.command = "awsView.selectProfile";
        if (left !== undefined && left < WARN_MS) {
          item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        }
        break;
      }
    }
    item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subs) s.dispose();
    this.authItem.dispose();
  }
}
