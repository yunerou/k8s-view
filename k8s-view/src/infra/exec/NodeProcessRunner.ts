import { spawn } from "node:child_process";
import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type ProcessOutcome, ProcessRunner, type ProcessSpec } from "../../app/ports/Runners";

const MAX_SUMMARY_LINES = 5;

/** Run argv directly (without a shell), stream stdout/stderr to "K8s View: Commands"; cancellation kills the process. */
@injectable()
export class NodeProcessRunner extends ProcessRunner implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("K8s View: Commands");

  run(spec: ProcessSpec, token: vscode.CancellationToken): Promise<ProcessOutcome> {
    return new Promise((resolve) => {
      this.channel.appendLine(`$ ${[spec.command, ...spec.args].join(" ")}`);
      const stderr: string[] = [];
      let cancelled = false;
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        shell: false,
        windowsHide: true,
      });
      const sub = token.onCancellationRequested(() => {
        cancelled = true;
        child.kill();
      });
      child.stdout.on("data", (d: Buffer) => this.channel.append(d.toString()));
      child.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        stderr.push(text);
        this.channel.append(text);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        sub.dispose();
        const message =
          err.code === "ENOENT"
            ? `'${spec.command}' was not found in PATH (see setting k8sView.extraPath)`
            : err.message;
        this.channel.appendLine(message);
        resolve({ code: null, cancelled, errorSummary: message });
      });
      child.on("close", (code) => {
        sub.dispose();
        this.channel.appendLine(cancelled ? "[cancelled]" : `[exit ${code ?? "?"}]`);
        const lines = stderr.join("").trim().split(/\r?\n/).filter(Boolean);
        resolve({ code, cancelled, errorSummary: lines.slice(-MAX_SUMMARY_LINES).join("\n") });
      });
    });
  }

  showOutput(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
