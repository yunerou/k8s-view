import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Workbench } from "../../app/ports/Workbench";

@injectable()
export class VscodeWorkbench extends Workbench {
  remoteAuthority(): string | undefined {
    if (vscode.env.remoteName !== "ssh-remote") return undefined;
    const uri = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    return uri?.scheme === "vscode-remote" ? uri.authority : undefined;
  }

  async openRemoteWindow(authority: string, folderPath: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: "vscode-remote", authority, path: folderPath });
    await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
  }

  openTerminal(name: string, shellPath: string, shellArgs: readonly string[]): void {
    vscode.window
      .createTerminal({ name, shellPath, shellArgs: [...shellArgs], iconPath: new vscode.ThemeIcon("terminal") })
      .show();
  }

  hasExtension(id: string): boolean {
    return vscode.extensions.getExtension(id) !== undefined;
  }

  async installExtension(id: string): Promise<void> {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", id);
  }

  async openExternal(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
