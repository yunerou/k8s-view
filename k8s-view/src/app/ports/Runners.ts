import type * as vscode from "vscode";
import type { RenderedRun } from "../../core/command/CommandTemplate";
import type { KubeResource } from "../../core/resource/KubeResource";

export interface BatchOutcome {
  readonly succeeded: number;
  readonly failures: readonly string[];
  readonly cancelled: boolean;
}

/** A single selection, bounded API concurrency, exact resource identities and per-resource results. */
export abstract class BatchRunner {
  abstract run(
    context: string,
    run: Extract<RenderedRun, { type: "batch" }>,
    targets: readonly KubeResource[],
    token: vscode.CancellationToken,
  ): Promise<BatchOutcome>;
}

export interface ProcessSpec {
  readonly title: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProcessOutcome {
  readonly code: number | null;
  readonly cancelled: boolean;
  /** Truncated stderr for error notifications. */
  readonly errorSummary: string;
}

/** Port: run processes without a shell (`execFile`), sending output to "K8s View: Commands". */
export abstract class ProcessRunner {
  abstract run(spec: ProcessSpec, token: vscode.CancellationToken): Promise<ProcessOutcome>;
  abstract showOutput(): void;
}

/** Port: run processes in a terminal (PTY), without a shell. */
export abstract class TerminalRunner {
  abstract open(spec: ProcessSpec & { readonly name: string }): void;
}

/** Port: the MS extension's `kubectl.v1.invokeCommand` (a command string; returns once execution completes). */
export abstract class KubectlRunner {
  abstract invoke(commandLine: string): Promise<{ code: number; stdout: string; stderr: string } | undefined>;
}

/** Port: `commands.executeCommand`. */
export abstract class CommandInvoker {
  abstract execute(id: string, args: readonly unknown[]): Promise<unknown>;
}

/** Port: workspace information for the executor. */
export abstract class WorkspaceInfo {
  abstract isTrusted(): boolean;
  abstract folder(): string | undefined;
  abstract platform(): string;
  /** Original extension host PATH. */
  abstract basePath(): string;
}
