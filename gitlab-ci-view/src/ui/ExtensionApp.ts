import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { BranchStatusService } from "../app/BranchStatusService";
import { FullViewModel } from "../app/FullViewModel";
import { PipelineService } from "../app/PipelineService";
import { Poller } from "../app/Poller";
import { Notifier } from "../app/ports/Notifier";
import { Prompter } from "../app/ports/Prompter";
import { RepoRegistry } from "../app/RepoRegistry";
import { RepoSelection } from "../app/RepoSelection";
import { RunPipelineFlow } from "../app/RunPipelineFlow";
import { TokenExpiryWatcher } from "../app/TokenExpiryWatcher";
import { TokenFlow } from "../app/TokenFlow";
import { TokenStore } from "../app/TokenStore";
import { EXTENSION_CONTEXT, LOGGER } from "../di/tokens";
import { VscodeRepoSource } from "../infra/git/VscodeRepoSource";
import { GitLabHttp } from "../infra/gitlab/GitLabHttp";
import { VscodeSettings } from "../infra/state/VscodeSettings";
import { registerCommands } from "./commands";
import { StatusBarController } from "./StatusBarController";
import { PIPELINES_VIEW_ID, PipelineTreeProvider } from "./tree/PipelineTreeProvider";
import { LogPanels } from "./webview/LogPanel";
import { PipelinePanel } from "./webview/PipelinePanel";

/** Startup: load Git repositories, register views/commands, start polling; collect Disposables in context.subscriptions. */
@injectable()
export class ExtensionApp {
  /** Hosts already notified of "token rejected" (avoid repeated warnings when multiple requests receive 401). */
  private readonly rejectedHosts = new Set<string>();

  constructor(
    private readonly branches = inject(BranchStatusService),
    private readonly fullView = inject(FullViewModel),
    private readonly runFlow = inject(RunPipelineFlow),
    private readonly expiry = inject(TokenExpiryWatcher),
    private readonly statusBar = inject(StatusBarController),
    private readonly panel = inject(PipelinePanel),
    private readonly logs = inject(LogPanels),
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly log = inject(LOGGER),
    private readonly settings = inject(VscodeSettings),
    private readonly repoSource = inject(VscodeRepoSource),
    private readonly api = inject(GitLabHttp),
    private readonly tokens = inject(TokenStore),
    private readonly repos = inject(RepoRegistry),
    private readonly selection = inject(RepoSelection),
    private readonly tokenFlow = inject(TokenFlow),
    private readonly pipelines = inject(PipelineService),
    private readonly poller = inject(Poller),
    private readonly tree = inject(PipelineTreeProvider),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
  ) {}

  async start(): Promise<void> {
    const subs = this.extension.subscriptions;
    subs.push(this.log, this.settings, this.repoSource, this.api, this.repos, this.selection, this.poller, this.tree);
    subs.push(
      this.branches,
      this.statusBar,
      this.fullView,
      this.panel,
      this.logs,
      this.expiry,
      this.poller.register(this.branches),
      this.poller.register(this.fullView),
      this.branches.onOpenRequested((t) => this.panel.open(t)),
      this.expiry.onUpdateRequested((host) => void vscode.commands.executeCommand("gitlabCiView.setToken", host)),
      this.api.onUnauthorized((host) => void this.onUnauthorized(host)),
      this.tokens.onDidChange((host) => {
        if (!this.tokens.meta(host)?.invalid) this.rejectedHosts.delete(host);
      }),
    );
    await this.repoSource.initialize();
    const view = vscode.window.createTreeView(PIPELINES_VIEW_ID, {
      treeDataProvider: this.tree,
      showCollapseAll: true,
    });
    subs.push(
      view,
      view.onDidChangeVisibility((e) => this.tree.setVisible(e.visible)),
      view.onDidCollapseElement((e) => this.tree.setExpanded(e.element, false)),
      vscode.window.onDidChangeWindowState((s) => this.poller.setFocused(s.focused)),
      ...registerCommands({
        runFlow: this.runFlow,
        panel: this.panel,
        logs: this.logs,
        repos: this.repos,
        selection: this.selection,
        tokenFlow: this.tokenFlow,
        pipelines: this.pipelines,
        poller: this.poller,
        tree: this.tree,
        prompter: this.prompter,
        notifier: this.notifier,
        settings: this.settings,
      }),
    );
    this.tree.setVisible(view.visible);
    this.poller.setFocused(vscode.window.state.focused);
    this.statusBar.start();
    this.expiry.start();
    this.poller.start();
  }

  private async onUnauthorized(host: string): Promise<void> {
    if (this.rejectedHosts.has(host)) return;
    this.rejectedHosts.add(host);
    await this.tokens.markInvalid(host);
    this.log.warn(`GitLab rejected the token for ${host} (401).`);
    const action = await this.notifier.warn(
      `GitLab rejected the token for ${host}. Update it to keep watching pipelines.`,
      "Update token",
    );
    if (action) await vscode.commands.executeCommand("gitlabCiView.setToken", host);
  }
}
