import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { holdOpenShell, signInShell } from "../../../src/infra/exec/terminalShell";

describe("holdOpenShell", () => {
  test("runs the command with positional args, then waits for Enter", () => {
    const { shellPath, shellArgs } = holdOpenShell("echo", ["a b", "$HOME", "it's"], "linux");
    expect(shellPath).toBe("/bin/sh");
    const out = execFileSync(shellPath, shellArgs, { input: "\n", encoding: "utf8" });
    expect(out).toContain("a b $HOME it's\n");
    expect(out).toContain("[exit code 0] Press Enter to close");
  });

  test("reports a failing exit code", () => {
    const { shellPath, shellArgs } = holdOpenShell("sh", ["-c", "exit 3"], "linux");
    expect(execFileSync(shellPath, shellArgs, { input: "\n", encoding: "utf8" })).toContain("[exit code 3]");
  });

  test("quotes arguments for PowerShell on Windows", () => {
    const { shellPath, shellArgs } = holdOpenShell("kubectl", ["get", "it's"], "win32");
    expect(shellPath).toBe("powershell.exe");
    expect(shellArgs.at(-1)).toContain("& 'kubectl' 'get' 'it''s'");
  });
});

describe("signInShell", () => {
  test("writes the credential to the file and exits with the plugin's code", () => {
    const dir = mkdtempSync(join(tmpdir(), "k8s-view-test-"));
    const out = join(dir, "credential.json");
    const { shellPath, shellArgs } = signInShell(
      out,
      "sh",
      ["-c", 'echo "prompt" >&2; echo \'{"status":{}}\''],
      "linux",
    );
    const r = spawnSync(shellPath, shellArgs, { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(out, "utf8")).toBe('{"status":{}}\n');
    rmSync(dir, { recursive: true });
  });

  test("keeps the terminal open on failure", () => {
    const { shellPath, shellArgs } = signInShell("/dev/null", "sh", ["-c", "exit 2"], "linux");
    const r = spawnSync(shellPath, shellArgs, { input: "\n", encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("Sign-in failed (exit 2)");
  });
});
