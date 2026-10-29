import type * as vscode from "vscode";

export interface InputOptions {
  readonly title: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly password?: boolean;
  validate?(value: string): string | undefined;
}

/** Port: user interaction (QuickPick, InputBox, modal confirmations, progress, notifications). */
export abstract class Prompter {
  abstract pick(title: string, items: readonly string[]): Promise<string | undefined>;
  abstract input(options: InputOptions): Promise<string | undefined>;
  /** Modal dialog; `true` when the user clicks `action`. */
  abstract confirm(message: string, detail: string, action: string): Promise<boolean>;
  /** Ask "Allow" on first execution of a workspace or remote config command (or when its definition changes). */
  abstract approveCommand(title: string, origin: "workspace" | "remote", detail: string): Promise<boolean>;
  /** Command blocked by policy (with a button opening `setting`, defaulting to `k8sView.commands.dangerous`). */
  abstract blocked(message: string, setting?: string): void;
  abstract withProgress<T>(title: string, task: (token: vscode.CancellationToken) => Promise<T>): Promise<T>;
  abstract info(message: string): void;
  /** Error with a "Show output" button. */
  abstract error(message: string, showOutput?: () => void): void;
}
