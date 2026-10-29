import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { WorkspaceInfo } from "../../app/ports/Runners";

@injectable()
export class VscodeWorkspaceInfo extends WorkspaceInfo {
  isTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }
  folder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
  platform(): string {
    return process.platform;
  }
  basePath(): string {
    return process.env["PATH"] ?? "";
  }
}
