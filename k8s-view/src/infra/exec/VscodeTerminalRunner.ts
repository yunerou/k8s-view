import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type ProcessSpec, TerminalRunner } from "../../app/ports/Runners";
import { holdOpenShell } from "./terminalShell";

/** Run processes in a terminal; keep it open afterward to read results (see `holdOpenShell`). */
@injectable()
export class VscodeTerminalRunner extends TerminalRunner {
  open(spec: ProcessSpec & { readonly name: string }): void {
    const terminal = vscode.window.createTerminal({
      name: spec.name,
      ...holdOpenShell(spec.command, spec.args),
      env: { ...spec.env },
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      iconPath: new vscode.ThemeIcon("terminal"),
    });
    terminal.show();
  }
}
