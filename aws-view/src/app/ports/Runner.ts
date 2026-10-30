export interface RunResult {
  /** `null`: the command could not be started (not installed, not executable). */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** Added to the extension host environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly onOutput?: (text: string) => void;
}

/** Port: run a local command (aws, ssh-keygen, session-manager-plugin…). Abort rejects with `CanceledError`. */
export abstract class Runner {
  abstract run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}
