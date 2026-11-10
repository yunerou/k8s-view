import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Confirmer } from "../../app/ports/Confirmer";

@injectable()
export class VscodeConfirmer extends Confirmer {
  async confirm(title: string, detail: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(title, { modal: true, detail }, "Allow")) === "Allow";
  }
}
