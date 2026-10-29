import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { CommandInvoker } from "../../app/ports/Runners";

@injectable()
export class VscodeCommandInvoker extends CommandInvoker {
  async execute(id: string, args: readonly unknown[]): Promise<unknown> {
    return vscode.commands.executeCommand(id, ...args);
  }
}
