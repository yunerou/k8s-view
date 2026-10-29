import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { EXTENSION_CONTEXT, LOGGER } from "../di/tokens";
import { ConfigLoader } from "../infra/config/ConfigLoader";
import { NodeProcessRunner } from "../infra/exec/NodeProcessRunner";
import { ExecCredentialProvider } from "../infra/kube/ExecCredentialProvider";
import { KubeClientFactory } from "../infra/kube/KubeClientFactory";
import { KubeConfigProvider } from "../infra/kube/KubeConfigProvider";
import { KubeResourceSource } from "../infra/kube/KubeResourceSource";
import { WatchManager } from "../infra/kube/WatchManager";
import { KubernetesExtensionGateway } from "../infra/ms-kubernetes/KubernetesExtensionGateway";
import { VscodeSettings } from "../infra/state/VscodeSettings";
import { TABLE_VIEW_TYPE } from "../shared/protocol";
import { ConfigWriter } from "../ui/ConfigWriter";
import { registerCommands } from "../ui/commands";
import { HELM_VALUES_SCHEME, HelmValuesDocumentProvider } from "../ui/HelmValuesDocumentProvider";
import { LogTerminals } from "../ui/LogTerminals";
import {
  DESCRIBE_SCHEME,
  DescribeDocumentProvider,
  MANIFEST_SCHEME,
  ManifestDocumentProvider,
} from "../ui/ManifestDocumentProvider";
import { PortForwardManager } from "../ui/PortForwardManager";
import { SECRET_SCHEME, SecretDocumentProvider } from "../ui/SecretDocumentProvider";
import { StatusBarController } from "../ui/StatusBarController";
import { SNIPPET_VIEW_ID, SnippetTreeProvider } from "../ui/tree/SnippetTreeProvider";
import { TreeViewManager } from "../ui/tree/TreeViewManager";
import { CONTEXT_VIEW_ID, ContextViewProvider } from "../ui/webview/ContextViewProvider";
import { ResourceTablePanels } from "../ui/webview/ResourceTablePanel";
import { CommandExecutor } from "./CommandExecutor";
import { CommandRegistry } from "./CommandRegistry";
import { ConfigService } from "./ConfigService";
import { ContextService } from "./ContextService";
import { HotkeyService } from "./HotkeyService";
import { KindViewService } from "./KindViewService";
import { ResourceSource } from "./ports/ResourceSource";
import { Settings } from "./ports/Settings";
import { ViewRegistry } from "./ViewRegistry";
import { ViewSessionManager } from "./ViewSessionManager";

/** Startup: load kubeconfig + config, register providers, commands, watchers; collect Disposables in context.subscriptions. */
@injectable()
export class ExtensionApp {
  /** Paused because the window lost focus (rather than the user clicking Pause). */
  private autoPaused = false;

  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly log = inject(LOGGER),
    private readonly gateway = inject(KubernetesExtensionGateway),
    private readonly kubeconfig = inject(KubeConfigProvider),
    private readonly contexts = inject(ContextService),
    private readonly config = inject(ConfigService),
    private readonly source = inject(ResourceSource),
    private readonly settings = inject(Settings),
    private readonly views = inject(ViewRegistry),
    private readonly sessions = inject(ViewSessionManager),
    private readonly commands = inject(CommandRegistry),
    private readonly executor = inject(CommandExecutor),
    private readonly trees = inject(TreeViewManager),
    private readonly statusBar = inject(StatusBarController),
    private readonly contextView = inject(ContextViewProvider),
    private readonly tables = inject(ResourceTablePanels),
    private readonly manifests = inject(ManifestDocumentProvider),
    private readonly describe = inject(DescribeDocumentProvider),
    private readonly portForwards = inject(PortForwardManager),
    private readonly logs = inject(LogTerminals),
    private readonly secrets = inject(SecretDocumentProvider),
    private readonly helmValues = inject(HelmValuesDocumentProvider),
    private readonly kindView = inject(KindViewService),
    private readonly writer = inject(ConfigWriter),
    private readonly loader = inject(ConfigLoader),
    private readonly processes = inject(NodeProcessRunner),
    private readonly clients = inject(KubeClientFactory),
    private readonly credentials = inject(ExecCredentialProvider),
    private readonly watches = inject(WatchManager),
    private readonly vscodeSettings = inject(VscodeSettings),
    private readonly hotkeys = inject(HotkeyService),
  ) {}

  async start(): Promise<void> {
    const subs = this.extension.subscriptions;
    subs.push(
      this.log,
      this.kubeconfig,
      this.clients,
      this.credentials,
      this.contexts,
      this.config,
      this.loader,
      this.views,
      this.commands,
      this.sessions,
      this.watches,
      this.trees,
      this.statusBar,
      this.contextView,
      this.tables,
      this.manifests,
      this.portForwards,
      this.logs,
      this.processes,
      this.vscodeSettings,
    );

    await this.kubeconfig.initialize();
    await this.contexts.initialize();
    this.kindView.restore();
    await this.config.reload();

    this.trees.start();
    this.statusBar.start();
    const snippets = new SnippetTreeProvider(this.commands, this.contexts);
    subs.push(
      snippets,
      vscode.window.createTreeView(SNIPPET_VIEW_ID, { treeDataProvider: snippets }),
      vscode.window.registerWebviewViewProvider(CONTEXT_VIEW_ID, this.contextView),
      vscode.workspace.registerTextDocumentContentProvider(MANIFEST_SCHEME, this.manifests),
      vscode.workspace.registerTextDocumentContentProvider(DESCRIBE_SCHEME, this.describe),
      vscode.workspace.registerTextDocumentContentProvider(SECRET_SCHEME, this.secrets),
      vscode.workspace.registerTextDocumentContentProvider(HELM_VALUES_SCHEME, this.helmValues),
      vscode.window.registerWebviewPanelSerializer(TABLE_VIEW_TYPE, this.tables),
      ...registerCommands({
        contexts: this.contexts,
        source: this.source,
        settings: this.settings,
        views: this.views,
        sessions: this.sessions,
        commands: this.commands,
        executor: this.executor,
        trees: this.trees,
        tables: this.tables,
        manifests: this.manifests,
        describe: this.describe,
        portForwards: this.portForwards,
        writer: this.writer,
        gateway: this.gateway,
        logs: this.logs,
        secrets: this.secrets,
        helmValues: this.helmValues,
        kindView: this.kindView,
        loader: this.loader,
        hotkeys: this.hotkeys,
      }),
      this.contexts.onDidChange((ctx) => {
        if (this.source instanceof KubeResourceSource) this.source.closeContextsExcept(ctx?.name);
        void this.onContextReady();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused && this.settings.pauseWhenUnfocused() && !this.source.paused) {
          this.autoPaused = true;
          this.source.setPaused(true);
        } else if (state.focused && this.autoPaused) {
          this.autoPaused = false;
          this.source.setPaused(false);
        }
      }),
    );
    await this.followKubernetesExtension();
    void this.onContextReady();
  }

  private async onContextReady(): Promise<void> {
    if (!this.contexts.current) return;
    const connection = await this.contexts.checkConnection();
    if (connection.state === "connected") {
      await this.contexts
        .loadNamespaces()
        .catch((e: unknown) => this.log.warn(`Cannot list namespaces: ${(e as Error).message}`));
    }
  }

  /** "Follow" mode: follow the MS extension's context/namespace (when enabled in settings). */
  private async followKubernetesExtension(): Promise<void> {
    try {
      const config = await this.gateway.configuration();
      this.extension.subscriptions.push(
        config.onDidChangeContext((name) => void this.contexts.applyExternalContext(name)),
        config.onDidChangeNamespace((ns) => void this.contexts.applyExternalNamespace(ns)),
      );
    } catch (e) {
      this.log.warn(`Kubernetes extension API unavailable, follow mode disabled: ${(e as Error).message}`);
    }
  }
}
