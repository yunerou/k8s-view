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
  async progress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        return task(controller.signal).finally(() => subscription.dispose());
      },
    );
  }
}
