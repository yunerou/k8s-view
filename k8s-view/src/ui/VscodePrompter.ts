import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type InputOptions, Prompter } from "../app/ports/Prompter";

@injectable()
export class VscodePrompter extends Prompter {
  async pick(title: string, items: readonly string[]): Promise<string | undefined> {
    return vscode.window.showQuickPick([...items], { title, placeHolder: title });
  }

  async input(options: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: options.title,
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.placeholder !== undefined ? { placeHolder: options.placeholder } : {}),
      ...(options.password ? { password: true } : {}),
      validateInput: (v) => options.validate?.(v) ?? null,
    });
  }

  async confirm(message: string, detail: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  async approveCommand(title: string, origin: "workspace" | "remote", detail: string): Promise<boolean> {
    const allow = vscode.l10n.t("Allow");
    const answer = await vscode.window.showWarningMessage(
      origin === "remote"
        ? vscode.l10n.t("Allow the remote command '{0}' to run?", title)
        : vscode.l10n.t("Allow the workspace command '{0}' to run?", title),
      {
        modal: true,
        detail:
          origin === "remote"
            ? vscode.l10n.t("It is defined in a remote config (k8sView.remoteConfigs):\n\n{0}", detail)
            : vscode.l10n.t("It is defined in this repository's .vscode/k8s-view config:\n\n{0}", detail),
      },
      allow,
    );
    return answer === allow;
  }

  blocked(message: string, setting = "k8sView.commands.dangerous"): void {
    const open = vscode.l10n.t("Open setting");
    void vscode.window.showWarningMessage(message, open).then((a) => {
      if (a === open) void vscode.commands.executeCommand("workbench.action.openSettings", setting);
    });
  }

  withProgress<T>(title: string, task: (token: vscode.CancellationToken) => Promise<T>): Promise<T> {
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_p, token) => task(token),
      ),
    );
  }

  info(message: string): void {
    void vscode.window.showInformationMessage(message);
  }

  error(message: string, showOutput?: () => void): void {
    if (!showOutput) {
      void vscode.window.showErrorMessage(message);
      return;
    }
    const label = vscode.l10n.t("Show output");
    void vscode.window.showErrorMessage(message, label).then((a) => {
      if (a === label) showOutput();
    });
  }
}
