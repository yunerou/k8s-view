import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Notifier } from "../../app/ports/Notifier";

@injectable()
export class VscodeNotifier extends Notifier {
  async info(message: string, ...actions: string[]): Promise<string | undefined> {
    return vscode.window.showInformationMessage(message, ...actions);
  }
  async warn(message: string, ...actions: string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, ...actions);
  }
  async error(message: string, ...actions: string[]): Promise<string | undefined> {
    return vscode.window.showErrorMessage(message, ...actions);
  }
}
