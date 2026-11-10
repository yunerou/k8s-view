import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { BridgeInstaller } from "../../../src/infra/mcp/BridgeInstaller";
import { DiscoveryFile } from "../../../src/infra/mcp/DiscoveryFile";
import { McpHttpServer } from "../../../src/infra/mcp/McpHttpServer";
import { McpController } from "../../../src/ui/McpController";
import { mcpFixture } from "../helpers/mcp";

let directory: string;
let f: ReturnType<typeof mcpFixture>;
let controller: McpController;
let resources: { server: McpHttpServer; discovery: DiscoveryFile; installer: BridgeInstaller };
let log: { warn: ReturnType<typeof vi.fn<(message: string) => void>> };
let foldersChanged: () => void;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-controller-"));
  f = mcpFixture();
  const source = join(directory, "bundle.js");
  await writeFile(source, "standalone bridge");
  resources = {
    server: new McpHttpServer(f.tools),
    discovery: new DiscoveryFile(join(directory, "home")),
    installer: new BridgeInstaller(source, join(directory, "home")),
  };
  log = { warn: vi.fn() };
  vi.spyOn(vscode.workspace, "onDidChangeWorkspaceFolders").mockImplementation((listener) => {
    foldersChanged = () => listener();
    return new vscode.Disposable(() => {});
  });
});
afterEach(async () => {
  await controller?.dispose();
  f.dispose();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function create() {
  controller = new McpController(f.tools, f.settings, {} as vscode.ExtensionContext, log, resources);
  return controller;
}
async function discovery(): Promise<{ port: number; secret: string; workspaceFolders: string[] }> {
  return JSON.parse(await readFile(resources.discovery.path, "utf8"));
}
it("starts once, republishes workspace folders, disables and re-enables with fresh secret", async () => {
  // The stub stores workspaceFolders as a field; assign through a spy on the event instead.
  const install = vi.spyOn(resources.installer, "install");
  await create().start();
  const first = await discovery();
  await controller.start();
  expect(install).toHaveBeenCalledOnce();
  foldersChanged();
  await controller.refresh();
  expect(await discovery()).toEqual(first);
  f.settings.set({ mcp: false }, ["mcp.enabled"]);
  await controller.refresh();
  await expect(stat(resources.discovery.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fetch(`http://127.0.0.1:${first.port}/mcp`)).rejects.toThrow();
  f.settings.set({ mcp: true }, ["mcp.enabled"]);
  await controller.refresh();
  expect((await discovery()).secret).not.toBe(first.secret);
});
it("serializes rapid toggles and disposal during installation without leaving discovery or endpoint", async () => {
  let release: () => void = () => {};
  vi.spyOn(resources.installer, "install").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = create().start();
  await vi.waitFor(() => expect(resources.installer.install).toHaveBeenCalledOnce());
  f.settings.set({ mcp: false }, ["mcp.enabled"]);
  f.settings.set({ mcp: true }, ["mcp.enabled"]);
  const disposed = controller.dispose();
  release();
  await pending;
  await disposed;
  await expect(stat(resources.discovery.path)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["install", "publish"])("cleans up and logs a safe warning after %s fails", async (method) => {
  if (method === "install") vi.spyOn(resources.installer, "install").mockRejectedValue(new Error("secret-sentinel"));
  else vi.spyOn(resources.discovery, "publish").mockRejectedValue(new Error("secret-sentinel"));
  await create().start();
  expect(log.warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-sentinel");
  await expect(stat(resources.discovery.path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("copies the chosen client/shell command and leaves clipboard alone when cancelled", async () => {
  let command: (...args: never[]) => unknown = () => {};
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation((id, handler) => {
    expect(id).toBe("gitlabCiView.copyMcpSetupCommand");
    command = handler;
    return new vscode.Disposable(() => {});
  });
  const write = vi.spyOn(vscode.env.clipboard, "writeText");
  const answers: (string | undefined)[] = ["Codex", "PowerShell", undefined];
  vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async () => answers.shift() as never);
  await create().start();
  await command();
  expect(write).toHaveBeenCalledWith(expect.stringContaining("codex mcp add gitlab-ci -- node '"));
  expect(write.mock.calls[0]?.[0]).not.toContain("--cwd");
  write.mockClear();
  await command();
  expect(write).not.toHaveBeenCalled();
});
