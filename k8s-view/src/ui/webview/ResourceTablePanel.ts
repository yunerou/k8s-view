import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Messenger } from "vscode-messenger";
import { stringify } from "yaml";
import { CommandExecutor } from "../../app/CommandExecutor";
import { CommandRegistry } from "../../app/CommandRegistry";
import { ContextService, errorMessage } from "../../app/ContextService";
import { HotkeyService } from "../../app/HotkeyService";
import { ClusterApi, KubeApiError } from "../../app/ports/ClusterApi";
import { ResourceSource } from "../../app/ports/ResourceSource";
import { Settings } from "../../app/ports/Settings";
import { StateStore } from "../../app/ports/StateStore";
import { ScopedViewService } from "../../app/ScopedViewService";
import { buildSection, diffSection, EMPTY_SNAPSHOT, type SectionSnapshot } from "../../app/TableModel";
import type { RegisteredView } from "../../app/ViewRegistry";
import type { SectionContent, ViewSession } from "../../app/ViewSession";
import { ViewSessionManager } from "../../app/ViewSessionManager";
import { ClusterContext, isProtectedContext, type NamespaceScope } from "../../core/context/ClusterContext";
import { formatAge } from "../../core/resource/format";
import type { KubeResource } from "../../core/resource/KubeResource";
import { resourceDocumentation } from "../../core/resource/resourceDocumentation";
import type { ParentVia } from "../../core/view/ParentIndex";
import { type ScopeDirection, type ScopeSource, scopeSourceOf, type ViewScope } from "../../core/view/ScopeResolver";
import { scopedDirection } from "../../core/view/scopedView";
import type { ChildDefinition, SectionDefinition } from "../../core/view/ViewDefinition";
import { EXTENSION_CONTEXT } from "../../di/tokens";
import type { HotkeyAction } from "../../shared/hotkeys";
import type { RelatedGroup, RelatedItem, ScopeRef } from "../../shared/protocol";
import {
  type CommandItem,
  type RowDetails,
  type RowRef,
  type SectionPrefs,
  TABLE_VIEW_TYPE,
  TableNotifications,
  TableRequests,
  type TableViewModel,
  type TableWebviewState,
} from "../../shared/protocol";
import { ConfigWriter } from "../ConfigWriter";
import { ManifestDocumentProvider } from "../ManifestDocumentProvider";
import { webviewHtml, webviewOptions } from "./html";

const VIA_LABEL: Record<ParentVia, string> = {
  owner: "owner",
  selects: "selects this",
  references: "references this",
  referencedBy: "referenced by this",
};

/** Scoped tabs (Open Related/Parent) share one layout per direction instead of one per source UID. */
const prefsKey = (viewId: string) => {
  const direction = scopedDirection(viewId);
  return `k8sView.tablePrefs/${direction ? `scoped:${direction}` : viewId}`;
};

/** The webview falls back to the first tab when the remembered one is gone. */
function activeOf(defs: readonly SectionDefinition[], id: string | undefined): string | undefined {
  return defs.some((d) => d.id === id) ? id : defs[0]?.id;
}

function toScopeRef(scope: ViewScope): ScopeRef {
  const s = scope.source;
  return {
    direction: scope.direction,
    context: scope.context,
    source: {
      group: s.group,
      kind: s.kind,
      ...(s.namespace ? { namespace: s.namespace } : {}),
      name: s.name,
      uid: s.uid,
    },
  };
}

/** Manage table instances and restore them after reload. */
@injectable()
export class ResourceTablePanels implements vscode.WebviewPanelSerializer<TableWebviewState>, vscode.Disposable {
  private readonly panels = new Set<TablePanel>();
  private readonly activeChanged = new vscode.EventEmitter<void>();
  /** A table tab gained/lost focus (the hotkey status bar item appears only when needed). */
  readonly onDidChangeActive = this.activeChanged.event;

  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly sessions = inject(ViewSessionManager),
    private readonly contexts = inject(ContextService),
    private readonly commands = inject(CommandRegistry),
    private readonly executor = inject(CommandExecutor),
    private readonly settings = inject(Settings),
    private readonly source = inject(ResourceSource),
    private readonly state = inject(StateStore),
    private readonly writer = inject(ConfigWriter),
    private readonly manifests = inject(ManifestDocumentProvider),
    private readonly hotkeys = inject(HotkeyService),
    private readonly scoped = inject(ScopedViewService),
    private readonly api = inject(ClusterApi),
  ) {}

  /** A table tab is active. */
  get tableActive(): boolean {
    return [...this.panels.values()].some((p) => p.panel.active);
  }

  private find(viewId: string): TablePanel | undefined {
    return [...this.panels].find((p) => p.viewId === viewId);
  }

  /** Open another instance, pinned to the active tab’s context when available. */
  openNew(viewId?: string): void {
    const active = [...this.panels].find((p) => p.panel.active);
    const id = viewId ?? active?.viewId;
    if (id) this.open(id, true, active?.viewId === id ? active.currentContext : this.contexts.current);
  }

  open(viewId: string, newTab = false, context?: ClusterContext): void {
    const existing = !newTab && this.find(viewId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const session = this.sessions.session(viewId);
    if (!session) {
      void vscode.window.showWarningMessage(vscode.l10n.t("View '{0}' is not available.", viewId));
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TABLE_VIEW_TYPE,
      `${session.definition.title} · table`,
      vscode.ViewColumn.Active,
      {
        ...webviewOptions(this.extension.extensionUri),
        retainContextWhenHidden: false,
      },
    );
    this.attach(panel, viewId, context);
  }

  /** Open Related / Open Parent tab for `source`; reveals the tab when it is already open. */
  openScoped(
    direction: ScopeDirection,
    source: ScopeSource,
    children?: readonly ChildDefinition[],
    context?: ClusterContext,
  ): boolean {
    const viewId = this.scoped.ensure(direction, source, children, context);
    if (!viewId) {
      void vscode.window.showInformationMessage(
        direction === "related"
          ? vscode.l10n.t("No related resources configured for {0}.", source.kind)
          : vscode.l10n.t("No parent relations for {0}.", source.kind),
      );
      return false;
    }
    this.open(viewId);
    if (context) this.find(viewId)?.useContext(context);
    return true;
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: TableWebviewState | undefined): Promise<void> {
    if (state?.scope) {
      const s = state.scope;
      const viewId =
        this.contexts.current?.name === s.context
          ? this.scoped.ensure(s.direction, { ...s.source, namespace: s.source.namespace })
          : undefined;
      if (!viewId) {
        panel.dispose();
        return;
      }
      panel.webview.options = webviewOptions(this.extension.extensionUri);
      this.attach(panel, viewId);
      return;
    }
    if (!state?.viewId || !this.sessions.session(state.viewId)) {
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.extension.extensionUri);
    this.attach(panel, state.viewId);
  }

  dispose(): void {
    for (const p of this.panels.values()) p.panel.dispose();
    this.activeChanged.dispose();
  }

  /** View-switch hotkey: focus an existing tab for that view, or switch views within the current tab. */
  switchView(table: TablePanel, viewId: string): void {
    if (viewId === table.viewId) return;
    if (scopedDirection(table.viewId)) {
      this.open(viewId);
      return;
    }
    const existing = this.find(viewId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    if (!this.sessions.session(viewId)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("View '{0}' is not available.", viewId));
      return;
    }
    table.retarget(viewId);
  }

  private attach(panel: vscode.WebviewPanel, viewId: string, context?: ClusterContext): void {
    const table = new TablePanel(panel, viewId, this.extension.extensionUri, this);
    this.panels.add(table);
    if (context) table.useContext(context);
    panel.onDidChangeViewState(() => this.activeChanged.fire());
    panel.onDidDispose(() => {
      table.dispose();
      this.panels.delete(table);
      if (!this.find(table.viewId)) this.scoped.remove(table.viewId);
      this.activeChanged.fire();
    });
    this.activeChanged.fire();
  }

  /** Shared dependencies for each TablePanel. */
  get deps() {
    return {
      api: this.api,
      sessions: this.sessions,
      contexts: this.contexts,
      commands: this.commands,
      executor: this.executor,
      settings: this.settings,
      source: this.source,
      state: this.state,
      writer: this.writer,
      manifests: this.manifests,
      hotkeys: this.hotkeys,
    };
  }
}

class TablePanel implements vscode.Disposable {
  private localContext: ClusterContext | undefined;
  private localSession: ViewSession | undefined;
  private readonly localChanged = new vscode.EventEmitter<ClusterContext | undefined>();
  private get context(): ClusterContext | undefined {
    return this.localContext ?? this.owner.deps.contexts.current;
  }
  private readonly messenger = new Messenger();
  private readonly participant;
  private snapshots = new Map<string, SectionSnapshot>();
  private resources = new Map<string, Map<string, KubeResource>>();
  private openSections = new Set<string>();
  /** Section tab shown in the webview: the only section holding leases. */
  private activeSection: string | undefined;
  private detailsKey: string | undefined;
  private parentsKey: string | undefined;
  private scopeKey = "";
  /** Session and view the tab last reset for: other views' changes leave the tab (and its drawer) untouched. */
  private bound: { session: ViewSession | undefined; view: RegisteredView | undefined } = {
    session: undefined,
    view: undefined,
  };
  private readonly parentNodes = new Map<string, KubeResource>();
  private readonly relatedNodes = new Map<string, { resource: KubeResource; children: readonly ChildDefinition[] }>();
  private dirty = false;
  /** The webview asked for its first model: until then nothing is built, so no section is watched before the tab is known. */
  private modelRequested = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    private currentViewId: string,
    extensionUri: vscode.Uri,
    private readonly owner: ResourceTablePanels,
  ) {
    const d = owner.deps;
    panel.webview.html = webviewHtml(panel.webview, extensionUri, "table", panel.title);
    panel.iconPath = new vscode.ThemeIcon("table");
    this.participant = this.messenger.registerWebviewPanel(panel);
    const m = this.messenger;
    this.disposables.push(
      m.onRequest(TableRequests.setIndependent, ({ enabled }) => this.setIndependent(enabled)),
      m.onRequest(TableRequests.pickContext, () => this.pickContext()),
      m.onRequest(TableRequests.pickNamespace, () => this.pickNamespace()),
      m.onRequest(TableRequests.describe, async (ref) => {
        const [r] = this.resolve(ref.sectionId, [ref.uid]);
        if (r && this.context)
          await vscode.commands.executeCommand("k8sView.describe", {
            context: this.context.name,
            group: r.kind.group,
            kind: r.kind.kind,
            namespace: r.namespace,
            name: r.name,
          });
      }),
      m.onRequest(TableRequests.getViewModel, async (params) => {
        await this.session?.whenReady();
        if (params?.activeSection) this.activeSection = params.activeSection;
        this.modelRequested = true;
        return this.model();
      }),
      m.onRequest(TableRequests.setActiveSection, ({ sectionId }) => {
        if (sectionId === this.activeSection) return;
        this.activeSection = sectionId;
        this.update();
      }),
      m.onRequest(TableRequests.commandsFor, ({ sectionId, uids }) => this.commandsFor(sectionId, uids)),
      m.onRequest(TableRequests.pickCommand, ({ sectionId, uids }) => this.pickCommand(sectionId, uids)),
      m.onRequest(TableRequests.runCommand, async ({ commandId, sectionId, uids }) => {
        const command = d.commands.get(commandId);
        if (!command || !this.commandsFor(sectionId, uids).some((c) => c.id === commandId)) return "blocked";
        return d.executor.execute(
          command,
          this.resolve(sectionId, uids),
          this.context ? { context: this.context } : {},
        );
      }),
      m.onRequest(TableRequests.details, (ref) => this.details(ref)),
      m.onRequest(TableRequests.openDocumentation, async (ref) => {
        const [resource] = this.resolve(ref.sectionId, [ref.uid]);
        const url = resource && resourceDocumentation(resource.kind);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
      }),
      m.onRequest(TableRequests.openScoped, ({ sectionId, uid, direction }) => {
        const [r] = this.resolve(sectionId, [uid]);
        if (!r) return false;
        const children = direction === "related" ? this.session?.sectionDefinition(sectionId)?.children : undefined;
        return this.owner.openScoped(direction, scopeSourceOf(r), children, this.localContext);
      }),
      m.onRequest(TableRequests.setScopeEnabled, ({ enabled }) => this.session?.setScopeEnabled(enabled)),
      m.onRequest(TableRequests.openScopeSource, async () => {
        const scope = this.session?.view.scope;
        if (!scope) return;
        const s = scope.source;
        await d.manifests.open({
          context: scope.context,
          group: s.group,
          kind: s.kind,
          namespace: s.namespace,
          name: s.name,
        });
      }),
      m.onRequest(TableRequests.related, ({ key }) => this.related(key)),
      m.onRequest(TableRequests.parents, ({ key }) => this.parents(key)),
      m.onRequest(TableRequests.closeRelated, ({ key, dispose }) => {
        if (dispose && key === this.detailsKey) this.closeDetails();
        else if (this.relatedNodes.has(key) || this.parentNodes.has(key)) this.session?.closeNode(key);
      }),
      m.onRequest(TableRequests.openManifest, async (ref) => {
        const [r] = this.resolve(ref.sectionId, [ref.uid]);
        const ctx = this.context;
        if (r && ctx)
          await d.manifests.open({
            context: ctx.name,
            group: r.kind.group,
            kind: r.kind.kind,
            namespace: r.namespace,
            name: r.name,
          });
      }),
      m.onRequest(TableRequests.savePrefs, async ({ sectionId, prefs }) => {
        const all = d.state.getWorkspace<Record<string, SectionPrefs>>(prefsKey(this.viewId)) ?? {};
        await d.state.setWorkspace(prefsKey(this.viewId), { ...all, [sectionId]: prefs });
      }),
      m.onRequest(TableRequests.saveToConfig, async ({ sectionId, prefs }) => {
        const view = this.session?.view;
        if (!view) return undefined;
        if (view.dynamic) {
          // "Single resource kind" has no file: create a custom view first (Edit view config).
          void vscode.window.showInformationMessage(
            vscode.l10n.t("This view has no config file. Use 'Edit view config' to create a custom view first."),
          );
          return undefined;
        }
        try {
          const path = await d.writer.saveColumns(view, sectionId, prefs);
          if (path) void vscode.window.showInformationMessage(vscode.l10n.t("Saved columns to {0}", path));
          return path;
        } catch (e) {
          void vscode.window.showErrorMessage(errorMessage(e));
          return undefined;
        }
      }),
      m.onRequest(TableRequests.refresh, () => this.session?.refresh()),
      m.onRequest(TableRequests.hotkey, ({ action, sectionId, uids }) => this.hotkey(action, sectionId, uids)),
      d.hotkeys.onDidChange(() =>
        this.messenger.sendNotification(TableNotifications.hotkeys, this.participant, d.hotkeys.state()),
      ),
      panel.onDidChangeViewState(() => this.visibilityChanged()),
      d.settings.onDidChange(() => {
        const ctx = this.localContext;
        if (!ctx) return;
        const protectedContext = isProtectedContext(ctx.name, d.settings.protectedContexts());
        if (protectedContext === ctx.isProtected) return;
        this.localContext = new ClusterContext(ctx.name, ctx.cluster, ctx.user, ctx.scope, protectedContext);
        this.localChanged.fire(this.localContext);
        this.reset();
      }),
      d.contexts.onDidChange(() => {
        if (!this.localContext) {
          this.localChanged.fire(this.context);
          this.reset();
        }
      }),
      d.sessions.onDidChangeSessions(() => {
        if (this.localSession) {
          const view = d.sessions.session(this.viewId)?.view;
          if (!view && scopedDirection(this.viewId)) {
            this.panel.dispose();
            return;
          }
          if (view && view !== this.localSession.view) {
            this.localSession.update(view);
            this.reset();
          }
          return;
        }
        const session = this.session;
        if (session !== this.bound.session || session?.view !== this.bound.view) this.reset();
      }),
    );
    this.createLocalSession();
    this.bind();
    this.subscribeSession();
    this.visibilityChanged();
  }

  get currentContext(): ClusterContext | undefined {
    return this.context;
  }

  get viewId(): string {
    return this.currentViewId;
  }

  private get session(): ViewSession | undefined {
    return this.localSession ?? this.owner.deps.sessions.session(this.viewId);
  }

  useContext(context: ClusterContext): void {
    this.closeSections();
    this.setVisible(false);
    this.localContext = context;
    if (!this.localSession) this.createLocalSession();
    this.setVisible(this.panel.visible);
    this.localChanged.fire(context);
    this.reset();
  }

  private setVisible(visible: boolean): void {
    if (this.localSession) this.localSession.setVisible("table", visible);
    else this.owner.deps.sessions.setTableVisible(this.viewId, visible);
  }

  private createLocalSession(): void {
    const self = this;
    this.localSession = this.owner.deps.sessions.createIndependent(this.viewId, {
      get current() {
        return self.context;
      },
      onDidChange: this.localChanged.event,
    });
    this.setVisible(this.panel.visible);
  }

  private setIndependent(enabled: boolean): void {
    if (enabled === !!this.localContext) return;
    if (enabled && !this.context) return;
    this.closeSections();
    this.setVisible(false);
    if (enabled) {
      this.localContext = this.context;
      this.localSession?.dispose();
      this.createLocalSession();
    } else {
      this.localSession?.dispose();
      this.localSession = undefined;
      this.localContext = undefined;
      this.createLocalSession();
    }
    this.reset();
  }

  private async pickContext(): Promise<void> {
    if (!this.localContext) return;
    const previous = this.context;
    const picked = await vscode.window.showQuickPick(
      this.owner.deps.contexts.contexts().map((c) => ({ label: c.name, info: c })),
      { title: vscode.l10n.t("Cluster for this tab") },
    );
    if (!picked || !this.localContext || previous !== this.context) return;
    const c = picked.info;
    this.closeSections();
    this.localContext = new ClusterContext(
      c.name,
      c.cluster,
      c.user,
      c.namespace ? { type: "single", name: c.namespace } : { type: "all" },
      isProtectedContext(c.name, this.owner.deps.settings.protectedContexts()),
    );
    this.localChanged.fire(this.localContext);
    this.reset();
  }

  private async selectNamespace(scope: NamespaceScope): Promise<void> {
    if (!this.localContext) return this.owner.deps.contexts.selectNamespace(scope);
    this.closeSections();
    this.localContext = this.localContext!.withScope(scope);
    this.localChanged.fire(this.localContext);
    this.reset();
  }

  private async pickNamespace(): Promise<void> {
    if (!this.localContext) {
      await vscode.commands.executeCommand("k8sView.selectNamespace");
      return;
    }
    const ctx = this.context;
    if (!ctx) return;
    let names: string[] = [];
    try {
      names = await this.owner.deps.api.listNamespaces(ctx.name);
    } catch (error) {
      if (!KubeApiError.isForbidden(error)) throw error;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t("All namespaces"), scope: { type: "all" } as NamespaceScope },
        ...names.sort().map((name) => ({ label: name, scope: { type: "single", name } as NamespaceScope })),
        { label: vscode.l10n.t("Enter namespace…"), scope: undefined },
      ],
      { title: vscode.l10n.t("Namespace for this tab") },
    );
    if (!picked || this.context !== ctx || !this.localContext) return;
    let scope = picked.scope;
    if (!scope) {
      const name = await vscode.window.showInputBox({
        title: vscode.l10n.t("Namespace"),
        validateInput: (v) =>
          /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) && v.length <= 63
            ? undefined
            : vscode.l10n.t("Enter a valid namespace"),
      });
      if (!name || this.context !== ctx || !this.localContext) return;
      scope = { type: "single", name };
    }
    await this.selectNamespace(scope);
  }

  /** Switch a tab's view: release the old view's leases, then send a new model (the webview discards old view preferences). */
  retarget(viewId: string): void {
    this.closeSections();
    this.setVisible(false);
    this.localSession?.dispose();
    this.localSession = undefined;
    this.currentViewId = viewId;
    this.createLocalSession();
    this.activeSection = undefined;
    this.dirty = false;
    this.visibilityChanged();
    this.reset();
  }

  private async hotkey(action: HotkeyAction, sectionId: string, uids: readonly string[]): Promise<void> {
    const d = this.owner.deps;
    if ("view" in action) this.owner.switchView(this, action.view);
    else if ("favorite" in action) {
      const viewId = d.settings.favoriteViews()[action.favorite - 1];
      if (viewId) this.owner.switchView(this, viewId);
      else void this.noFavorite(action.favorite);
    } else if ("allNamespaces" in action) await this.selectNamespace({ type: "all" });
    else if ("namespace" in action) await this.selectNamespace({ type: "single", name: action.namespace });
    else if ("command" in action) {
      const command = d.commands.get(action.command);
      if (!command) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Unknown command '{0}'", action.command));
        return;
      }
      await d.executor.execute(command, this.resolve(sectionId, uids), this.context ? { context: this.context } : {});
    } else if (action.action === "runLast") {
      if (!d.executor.lastRun) {
        void vscode.window.showInformationMessage(vscode.l10n.t("No command has been run yet."));
        return;
      }
      const targets = this.resolve(sectionId, uids);
      await d.executor.execute(
        d.executor.lastRun.command,
        targets.length > 0 ? targets : d.executor.lastRun.targets,
        this.context ? { context: this.context } : {},
      );
    } else if (action.action === "pickNamespace") await this.pickNamespace();
    else if (action.action === "pickView") {
      const favorites = d.settings.favoriteViews();
      const picked = await vscode.window.showQuickPick(
        d.sessions.all().map((s) => {
          const slot = favorites.indexOf(s.definition.id);
          return {
            label: `$(${s.definition.icon ?? "list-tree"}) ${s.definition.title}`,
            description: [
              slot >= 0 ? `$(star-full) ${slot + 1}` : undefined,
              s.definition.id === this.viewId ? vscode.l10n.t("current") : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
            viewId: s.definition.id,
          };
        }),
        { title: vscode.l10n.t("K8s View: Switch table view"), matchOnDescription: true },
      );
      if (picked) this.owner.switchView(this, picked.viewId);
    }
  }

  private async noFavorite(slot: number): Promise<void> {
    const configure = vscode.l10n.t("Configure favorite views…");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("No favorite view in slot {0}.", slot),
      configure,
    );
    if (choice === configure) await vscode.commands.executeCommand("k8sView.configureFavoriteViews");
  }

  dispose(): void {
    this.closeSections();
    this.setVisible(false);
    this.localSession?.dispose();
    this.localChanged.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private sessionSubscription: vscode.Disposable | undefined;

  private bind(): void {
    const session = this.session;
    this.bound = { session, view: session?.view };
  }

  private subscribeSession(): void {
    this.sessionSubscription?.dispose();
    const session = this.session;
    this.sessionSubscription = session?.onDidChange(() => this.update());
    if (this.sessionSubscription) this.disposables.push(this.sessionSubscription);
  }

  private visibilityChanged(): void {
    const visible = this.panel.visible;
    this.setVisible(visible);
    if (!visible) {
      this.closeSections();
      return;
    }
    if (this.dirty) this.reset();
  }

  private closeSections(): void {
    const session = this.session;
    for (const id of this.openSections) session?.closeSection(id, "table");
    this.closeDetails();
    this.openSections.clear();
  }

  private model(): TableViewModel {
    const session = this.session;
    const ctx = this.context;
    const now = Date.now();
    this.snapshots = new Map();
    this.resources = new Map();
    const defs = session?.sections() ?? [];
    const active = activeOf(defs, this.activeSection);
    const sections = defs.map((def) => {
      const content = this.content(session!, def, active);
      const built = buildSection(def, content, ctx?.scope.type === "all", now);
      this.snapshots.set(def.id, diffSection(def.id, EMPTY_SNAPSHOT, built).snapshot);
      this.resources.set(def.id, new Map(content.items.map((r) => [r.uid, r])));
      return built;
    });
    const scope = session?.view.scope;
    const scopeState = session?.scopeState();
    this.scopeKey = JSON.stringify(scopeState ?? null);
    this.dirty = false;
    return {
      viewId: this.viewId,
      title: session?.definition.title ?? this.viewId,
      context: ctx?.name,
      namespaceScope: ctx?.scope,
      independent: !!this.localContext,
      ...(scope && scopeState ? { scope: { ...toScopeRef(scope), ...scopeState } } : {}),
      sections,
      prefs: this.owner.deps.state.getWorkspace<Record<string, SectionPrefs>>(prefsKey(this.viewId)) ?? {},
      hotkeys: this.owner.deps.hotkeys.state(),
    };
  }

  private reset(): void {
    if (!this.session && scopedDirection(this.viewId)) {
      // Scoped view removed (context changed): its tab has nothing left to show.
      this.panel.dispose();
      return;
    }
    this.closeDetails();
    this.bind();
    this.subscribeSession();
    const session = this.session;
    if (session) this.panel.title = `${session.definition.title} · ${this.localContext?.name ?? "table"}`;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    if (!this.modelRequested) return;
    this.messenger.sendNotification(TableNotifications.reset, this.participant, this.model());
  }

  private update(): void {
    const session = this.session;
    if (!session || !this.modelRequested) return;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    const ctx = this.context;
    if (this.detailsKey)
      this.messenger.sendNotification(TableNotifications.relatedChanged, this.participant, undefined);
    const now = Date.now();
    const defs = session.sections();
    if (defs.map((d) => d.id).join("\n") !== [...this.snapshots.keys()].join("\n")) {
      this.reset();
      return;
    }
    const active = activeOf(defs, this.activeSection);
    for (const def of defs) {
      const content = this.content(session, def, active);
      const built = buildSection(def, content, ctx?.scope.type === "all", now);
      const { patch, snapshot, changed } = diffSection(def.id, this.snapshots.get(def.id) ?? EMPTY_SNAPSHOT, built);
      this.snapshots.set(def.id, snapshot);
      this.resources.set(def.id, new Map(content.items.map((r) => [r.uid, r])));
      if (changed) this.messenger.sendNotification(TableNotifications.patch, this.participant, patch);
    }
    // Scope turned off/on or source deleted: banner and rows change together, so send a full model.
    if (JSON.stringify(session.scopeState() ?? null) !== this.scopeKey) this.reset();
  }

  /** Only the active tab holds leases; other tabs show what the shared store already has (no count while unknown). */
  private content(session: ViewSession, def: SectionDefinition, active: string | undefined): SectionContent {
    if (def.id === active) {
      this.openSections.add(def.id);
      return session.openSection(def.id, "table");
    }
    if (this.openSections.delete(def.id)) session.closeSection(def.id, "table");
    return session.openSection(def.id, "table", { hold: false });
  }

  private resolve(sectionId: string, uids: readonly string[]): KubeResource[] {
    const map = this.resources.get(sectionId);
    return uids.map((u) => map?.get(u)).filter((r): r is KubeResource => !!r);
  }

  private commandsFor(sectionId: string, uids: readonly string[]): CommandItem[] {
    const d = this.owner.deps;
    const targets = this.resolve(sectionId, uids);
    if (targets.length === 0 || targets.length !== uids.length) return [];
    const restricted = d.settings.dangerousCommands() === "restricted";
    const batch = targets.length > 1;
    return d.commands
      .all()
      .filter((c) => !c.isSnippet && c.isBatch === batch && targets.every((t) => c.matches(t)))
      .map((c) => ({
        id: c.id,
        title: c.title,
        dangerous: c.dangerous,
        blocked: c.dangerous && restricted,
        ...(c.group ? { group: c.group } : {}),
        ...(c.icon ? { icon: c.icon } : {}),
      }));
  }

  private async pickCommand(sectionId: string, uids: readonly string[]): Promise<"details" | undefined> {
    const context = this.context;
    const commands = this.commandsFor(sectionId, uids);
    const items: (vscode.QuickPickItem & { action?: string })[] = [];
    if (uids.length === 1 && this.resolve(sectionId, uids).length === 1)
      items.push({ label: "$(info) Details", action: "details" });
    let group: string | undefined;
    for (const c of commands) {
      if (c.group && c.group !== group) items.push({ label: c.group, kind: vscode.QuickPickItemKind.Separator });
      group = c.group;
      items.push({
        label: `${c.icon ? `$(${c.icon}) ` : ""}${c.title}`,
        ...(c.blocked
          ? {
              description: vscode.l10n.t("Blocked by settings"),
              detail: "Enable k8sView.commands.dangerous to run this command",
            }
          : c.dangerous
            ? { description: vscode.l10n.t("Dangerous command") }
            : {}),
        action: `command:${c.id}`,
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: uids.length > 1 ? vscode.l10n.t("Batch Commands ({0} resources)", uids.length) : vscode.l10n.t("Commands"),
      matchOnDescription: true,
    });
    if (!picked?.action || context !== this.context) return undefined;
    if (picked.action === "details") return "details";
    const current = this.commandsFor(sectionId, uids).find((c) => `command:${c.id}` === picked.action);
    const command = current && !current.blocked ? this.owner.deps.commands.get(current.id) : undefined;
    if (command)
      await this.owner.deps.executor.execute(
        command,
        this.resolve(sectionId, uids),
        this.context ? { context: this.context } : {},
      );
    return undefined;
  }

  private closeDetails(): void {
    if (this.detailsKey) this.session?.closeNode(this.detailsKey);
    if (this.parentsKey) this.session?.closeNode(this.parentsKey);
    this.detailsKey = undefined;
    this.parentsKey = undefined;
    this.relatedNodes.clear();
    this.parentNodes.clear();
  }

  /** Latest copy of `r` from the store (relations are re-read on live updates). */
  private fresh(r: KubeResource): KubeResource {
    const ctx = this.context;
    if (!ctx) return r;
    return (
      this.owner.deps.source
        .lookup(ctx)
        .list(r.kind.group, r.kind.kind, r.namespace)
        ?.find((x) => x.uid === r.uid) ?? r
    );
  }

  private parents(key: string): RelatedGroup[] {
    const node = this.parentNodes.get(key);
    const session = this.session;
    if (!node || !session) return [];
    const d = this.owner.deps;
    const index = d.sessions.parentIndex;
    const content = session.openParents(key, this.fresh(node), index);
    const retained = new Set<string>();
    const byKind = new Map<string, RelatedItem[]>();
    for (const hit of content.items) {
      const r = hit.resource;
      const itemKey = `${key}/${r.uid}`;
      retained.add(itemKey);
      this.parentNodes.set(itemKey, r);
      const status = d.sessions.statusOf(r);
      const items = byKind.get(r.kind.kind) ?? [];
      items.push({
        key: itemKey,
        expandable: index.hasParents(r),
        kind: r.kind.kind,
        name: r.name,
        ...(r.namespace ? { namespace: r.namespace } : {}),
        level: status?.level ?? "unknown",
        description: hit.via.map((v) => VIA_LABEL[v]).join(", "),
      });
      byKind.set(r.kind.kind, items);
    }
    for (const oldKey of [...this.parentNodes.keys()]) {
      if (oldKey.startsWith(`${key}/`) && ![...retained].some((k) => oldKey === k || oldKey.startsWith(`${k}/`))) {
        session.closeNode(oldKey);
        this.parentNodes.delete(oldKey);
      }
    }
    const groups: RelatedGroup[] = [...byKind].map(([kind, items]) => ({ key: `${key}/${kind}`, title: kind, items }));
    if (groups.length === 0 && (content.pending || content.hints.length > 0)) {
      return [{ key: `${key}/-`, title: "Parents", pending: content.pending, hints: content.hints, items: [] }];
    }
    if (content.hints.length > 0 && groups[0]) groups[0] = { ...groups[0], hints: content.hints };
    return groups;
  }

  private related(key: string): RelatedGroup[] {
    const node = this.relatedNodes.get(key);
    const session = this.session;
    if (!node || !session) return [];
    const ctx = this.context;
    if (!ctx) return [];
    const resource = this.fresh(node.resource);
    const retained = new Set<string>();
    const groups = session.openChildren(key, resource, node.children).map((c) => ({
      key: `${key}/${c.def.id}`,
      title: c.def.title ?? c.def.id,
      pending: c.pending,
      hints: c.hints,
      items: c.items.map((i, index) => {
        const itemKey = `${key}/${c.def.id}/${i.type === "resource" ? i.resource.uid : index}`;
        if (i.type === "resource") {
          retained.add(itemKey);
          this.relatedNodes.set(itemKey, { resource: i.resource, children: c.def.children });
          const status = c.def.status(i.resource);
          return {
            key: itemKey,
            expandable: c.def.children.some((child) => !child.hidden),
            kind: i.resource.kind.kind,
            name: c.def.label(i.resource),
            ...(i.resource.namespace ? { namespace: i.resource.namespace } : {}),
            ...status,
            description: c.def.describe(i.resource, Date.now()),
          };
        }
        return i.type === "field"
          ? {
              key: itemKey,
              kind: "field",
              name: i.label,
              level: "unknown" as const,
              ...(i.icon ? { icon: i.icon } : {}),
              ...(i.description ? { description: i.description } : {}),
            }
          : { key: itemKey, kind: i.kind, name: i.name, level: "warning" as const, description: "not found" };
      }),
    }));
    for (const oldKey of this.relatedNodes.keys()) {
      if (
        oldKey.startsWith(`${key}/`) &&
        ![...retained].some((childKey) => oldKey === childKey || oldKey.startsWith(`${childKey}/`))
      ) {
        session.closeNode(oldKey);
        this.relatedNodes.delete(oldKey);
      }
    }
    return groups;
  }

  private async details(ref: RowRef): Promise<RowDetails> {
    const d = this.owner.deps;
    const session = this.session;
    const [r] = this.resolve(ref.sectionId, [ref.uid]);
    const ctx = this.context;
    if (!r || !session || !ctx) return { overview: [], yaml: "", events: [], conditions: [], related: [], parents: [] };
    const section = session.sectionDefinition(ref.sectionId);
    const status = section?.status(r);
    const age = r.ageMs(Date.now());
    const overview = [
      { label: "Kind", value: r.kind.group ? `${r.kind.kind}.${r.kind.group}` : r.kind.kind },
      { label: "Name", value: r.name },
      ...(r.namespace ? [{ label: "Namespace", value: r.namespace }] : []),
      { label: "Status", value: `${status?.level ?? "unknown"}${status?.summary ? ` — ${status.summary}` : ""}` },
      ...(age !== undefined ? [{ label: "Age", value: formatAge(age) }] : []),
      {
        label: "Labels",
        value:
          Object.entries(r.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "—",
      },
      ...(r.owners.length > 0
        ? [{ label: "Owners", value: r.owners.map((o) => `${o.kind}/${o.name}`).join(", ") }]
        : []),
      { label: "UID", value: r.uid },
    ];
    this.closeDetails();
    this.detailsKey = `table:details:${r.uid}`;
    if (section) this.relatedNodes.set(this.detailsKey, { resource: r, children: section.children });
    const related = this.related(this.detailsKey);
    this.parentsKey = `table:parents:${r.uid}`;
    this.parentNodes.set(this.parentsKey, r);
    const parents = this.parents(this.parentsKey);
    let events: RowDetails["events"] = [];
    try {
      events = (await d.source.events(ctx, r)).map((e) => ({
        type: String(e["type"] ?? ""),
        reason: String(e["reason"] ?? ""),
        message: String(e["message"] ?? ""),
        count: Number(e["count"] ?? 1),
        lastTimestamp: (e["lastTimestamp"] ?? e["eventTime"] ?? e.metadata.creationTimestamp) as string | undefined,
      }));
    } catch {
      // No permission to read events: skip.
    }
    const documentationUrl = resourceDocumentation(r.kind);
    return {
      ...(documentationUrl ? { documentation: { kind: r.kind.kind, url: documentationUrl } } : {}),
      overview,
      ...(r.kind.kind === "Pod" && r.kind.group === ""
        ? {
            containers: (
              (
                r.object["spec"] as
                  | {
                      containers?: {
                        name: string;
                        image?: string;
                        command?: string[];
                        args?: string[];
                        resources?: Record<string, unknown>;
                      }[];
                    }
                  | undefined
              )?.containers ?? []
            ).map((c) => ({
              name: c.name,
              image: c.image ?? "",
              command: c.command ?? [],
              args: c.args ?? [],
              resources: c.resources ?? {},
            })),
          }
        : {}),
      yaml: stringify(r.object, { lineWidth: 0 }),
      events,
      conditions: r.conditions.map((c) => ({ ...c })),
      related,
      parents,
    };
  }
}
