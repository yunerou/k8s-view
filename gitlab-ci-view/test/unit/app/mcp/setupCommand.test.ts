import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { setupCommand } from "../../../../src/app/mcp/setupCommand";

it("generates both CLI registrations without pinning a workspace or including secrets", () => {
  expect(setupCommand("Claude Code", "POSIX", "/home/user/.gitlab-ci-view/mcp-bridge.js")).toBe(
    "claude mcp add --transport stdio --scope user gitlab-ci -- node '/home/user/.gitlab-ci-view/mcp-bridge.js'",
  );
  expect(setupCommand("Codex", "POSIX", "/home/user/bridge.js")).toBe(
    "codex mcp add gitlab-ci -- node '/home/user/bridge.js'",
  );
});
it("round-trips POSIX paths containing spaces, apostrophes, dollars and backticks", async () => {
  const path = "/home/O'Neil/a $value `command`/bridge.js";
  const quoted = setupCommand("Codex", "POSIX", path).split(" -- node ")[1]!;
  const result = await promisify(execFile)("/bin/sh", ["-c", `printf '%s' ${quoted}`]);
  expect(result.stdout).toBe(path);
});
it("quotes PowerShell paths as literal single-quoted strings", () => {
  expect(setupCommand("Codex", "PowerShell", "C:/O'Neil/$x `cmd`/bridge.js")).toBe(
    "codex mcp add gitlab-ci -- node 'C:/O''Neil/$x `cmd`/bridge.js'",
  );
});
