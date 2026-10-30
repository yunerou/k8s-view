import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "@vscode/test-cli";

const userDataDir = mkdtempSync(join(tmpdir(), "aws-it-"));
process.once("exit", () => rmSync(userDataDir, { recursive: true, force: true }));

const fixtures = resolve(import.meta.dirname, "test/fixtures/aws");

export default defineConfig({
  label: "integration",
  files: "out/test/integration/**/*.test.js",
  version: "1.125.0",
  // IPC sockets on macOS have a 103-character limit: use a short user-data-dir.
  launchArgs: ["--user-data-dir", userDataDir, "--disable-workspace-trust"],
  mocha: { ui: "bdd", timeout: 60_000 },
  env: {
    AWS_VIEW_INTEGRATION: "1",
    AWS_CONFIG_FILE: join(fixtures, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(fixtures, "credentials"),
  },
});
