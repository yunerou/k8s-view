import { join } from "node:path";
import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { McpTools } from "../app/mcp/McpTools";
import { setupCommand } from "../app/mcp/setupCommand";
import { Settings } from "../app/ports/Settings";
import { EXTENSION_CONTEXT, LOGGER } from "../di/tokens";
import { BridgeInstaller } from "../infra/mcp/BridgeInstaller";
import { DiscoveryFile, defaultMcpDirectory } from "../infra/mcp/DiscoveryFile";
import { type Endpoint, McpHttpServer } from "../infra/mcp/McpHttpServer";

interface Runtime {
  server: McpHttpServer;
  discovery: DiscoveryFile;
  installer: BridgeInstaller;
}
function runtime(tools: McpTools, extension: vscode.ExtensionContext): Runtime {
  // Integration hosts must never publish to the user's live discovery/bridge directory.
  const directory =
    process.env["GITLAB_CI_VIEW_INTEGRATION"] === "1"
      ? join(extension.globalStorageUri.fsPath, "mcp-integration")
      : defaultMcpDirectory();
  return {
    server: new McpHttpServer(tools),
    discovery: new DiscoveryFile(directory),
    installer: new BridgeInstaller(extension.asAbsolutePath("dist/mcp-bridge.js"), directory),
  };
}

@injectable()
export class McpController {
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private started = false;
  private endpoint: Endpoint | undefined;
  private readonly subscriptions: { dispose(): void }[] = [];

  constructor(
    tools = inject(McpTools),
    private readonly settings = inject(Settings),
    extension = inject(EXTENSION_CONTEXT),
    private readonly log: { warn(message: string): void } = inject(LOGGER),
    private readonly resources: Runtime = runtime(tools, extension),
  ) {}

  get discoveryPath(): string {
    return this.resources.discovery.path;
  }

  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.subscriptions.push(
        this.settings.onDidChange((keys) => {
          if (keys.includes("mcp.enabled")) void this.refresh();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          void this.refresh();
        }),
        vscode.commands.registerCommand("gitlabCiView.copyMcpSetupCommand", () => this.copySetupCommand()),
      );
    }
    await this.refresh();
  }

  refresh(): Promise<void> {
    this.queue = this.queue
      .then(() => this.reconcile())
      .catch(async () => {
        this.log.warn("MCP setup failed. Check local directory permissions and the installed bridge bundle.");
        await this.stop().catch(() => {});
      });
    return this.queue;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const sub of this.subscriptions.splice(0)) sub.dispose();
    // Cancel pending confirmations immediately, even if a queued operation is still running.
    await this.resources.server.stop();
    await this.refresh();
  }

  private async stop(): Promise<void> {
    this.endpoint = undefined;
    await this.resources.server.stop();
    await this.resources.discovery.remove();
  }

  private async reconcile(): Promise<void> {
    if (this.disposed || !this.settings.mcpEnabled()) {
      await this.stop();
      return;
    }
    if (!this.endpoint) {
      await this.resources.installer.install();
      if (this.disposed || !this.settings.mcpEnabled()) {
        await this.stop();
        return;
      }
      this.endpoint = await this.resources.server.start();
    }
    if (this.disposed || !this.settings.mcpEnabled()) {
      await this.stop();
      return;
    }
    await this.resources.discovery.publish(
      this.endpoint,
      (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath),
    );
  }

  private async copySetupCommand(): Promise<void> {
    if (!this.endpoint) {
      void vscode.window.showInformationMessage(
        "Enable gitlabCiView.mcp.enabled and ensure the MCP bridge installed successfully first.",
      );
      return;
    }
    const client = await vscode.window.showQuickPick(["Claude Code", "Codex"], { title: "MCP client" });
    if (client !== "Claude Code" && client !== "Codex") return;
    const shell = await vscode.window.showQuickPick(["POSIX", "PowerShell"], { title: "Terminal shell" });
    if (shell !== "POSIX" && shell !== "PowerShell") return;
    await vscode.env.clipboard.writeText(setupCommand(client, shell, this.resources.installer.path));
    void vscode.window.showInformationMessage(
      "MCP setup command copied. Run it in your terminal, then check /mcp and call list_repos. For IDE workspace routing, use project config with --cwd; see the README. Node.js 22+ must be on PATH.",
    );
  }
}
