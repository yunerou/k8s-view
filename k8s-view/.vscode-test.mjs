import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "integration",
  files: "out/test/integration/**/*.test.js",
  version: "1.125.0",
  installExtensions: ["ms-kubernetes-tools.vscode-kubernetes-tools"],
  workspaceFolder: "./test/fixtures/workspace",
  // IPC sockets on macOS have a 103-character limit: use a short user-data-dir.
  launchArgs: ["--user-data-dir", join(tmpdir(), "k8s-view-it"), "--disable-workspace-trust"],
  mocha: { ui: "bdd", timeout: 60_000 },
  env: { K8S_VIEW_INTEGRATION: "1" },
});
