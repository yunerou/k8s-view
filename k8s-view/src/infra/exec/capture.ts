import { execFile } from "node:child_process";

export interface CaptureResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run argv without a shell and return all output (for `kubectl describe`). */
export function capture(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs = 30_000,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as NodeJS.ErrnoException).code === "number"
            ? Number((err as NodeJS.ErrnoException).code)
            : 1
          : 0;
        const message =
          err && (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `'${command}' was not found in PATH (see setting k8sView.extraPath)`
            : "";
        resolve({ code, stdout: String(stdout), stderr: message || String(stderr) });
      },
    );
  });
}
