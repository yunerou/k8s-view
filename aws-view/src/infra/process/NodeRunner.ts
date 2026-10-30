import { spawn } from "node:child_process";
import { injectable } from "@needle-di/core";
import { Runner, type RunOptions, type RunResult } from "../../app/ports/Runner";
import { CanceledError } from "../../core/util/errors";

@injectable()
export class NodeRunner extends Runner {
  run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const { signal, env, onOutput } = options;
    if (signal?.aborted) return Promise.reject(new CanceledError());
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(command, [...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        onOutput?.(text);
      });
      child.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        onOutput?.(text);
      });
      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ code: null, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(new CanceledError());
        else resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
