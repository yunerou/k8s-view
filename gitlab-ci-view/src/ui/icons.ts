import * as vscode from "vscode";
import { type StatusLevel, statusIcon, statusLevel } from "../core/gitlab/status";

const LEVEL_COLOR: Record<StatusLevel, string> = {
  ok: "testing.iconPassed",
  error: "testing.iconFailed",
  warning: "problemsWarningIcon.foreground",
  progress: "charts.blue",
  manual: "charts.purple",
  neutral: "disabledForeground",
};

export function statusThemeIcon(status: string, allowFailure = false): vscode.ThemeIcon {
  return new vscode.ThemeIcon(
    statusIcon(status, allowFailure),
    new vscode.ThemeColor(LEVEL_COLOR[statusLevel(status, allowFailure)]),
  );
}
