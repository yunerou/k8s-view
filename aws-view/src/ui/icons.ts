import * as vscode from "vscode";
import { type Instance, isTransitional } from "../core/ec2/model";

export function instanceIcon(i: Instance): vscode.ThemeIcon {
  if (isTransitional(i.state)) return new vscode.ThemeIcon("loading~spin");
  if (i.state === "running") {
    const color = i.ssm === "Online" ? "testing.iconPassed" : "problemsWarningIcon.foreground";
    return new vscode.ThemeIcon("vm-running", new vscode.ThemeColor(color));
  }
  return new vscode.ThemeIcon("vm-outline", new vscode.ThemeColor("disabledForeground"));
}
