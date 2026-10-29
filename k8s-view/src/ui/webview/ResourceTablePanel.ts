import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Messenger } from "vscode-messenger";
import { stringify } from "yaml";
import { CommandExecutor } from "../../app/CommandExecutor";
import { CommandRegistry } from "../../app/CommandRegistry";
import { ContextService, errorMessage } from "../../app/ContextService";
import { HotkeyService } from "../../app/HotkeyService";
import { ResourceSource } from "../../app/ports/ResourceSource";
import { Settings } from "../../app/ports/Settings";
import { StateStore } from "../../app/ports/StateStore";
import { buildSection, diffSection, EMPTY_SNAPSHOT, type SectionSnapshot } from "../../app/TableModel";
import type { ViewSession } from "../../app/ViewSession";
import { ViewSessionManager } from "../../app/ViewSessionManager";
import { formatAge } from "../../core/resource/format";
import type { KubeResource } from "../../core/resource/KubeResource";
import type { ChildDefinition } from "../../core/view/ViewDefinition";
import { EXTENSION_CONTEXT } from "../../di/tokens";
import type { HotkeyAction } from "../../shared/hotkeys";
import type { RelatedGroup } from "../../shared/protocol";
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

const prefsKey = (viewId: string) => `k8sView.tablePrefs/${viewId}`;

/** Manage table tabs (one per view) and restore them after reload. */
@injectable()
export class ResourceTablePanels implements vscode.WebviewPanelSerializer<TableWebviewState>, vscode.Disposable {
  private readonly panels = new Map<string, TablePanel>();
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
  ) {}

  /** A table tab is active. */
  get tableActive(): boolean {
    return [...this.panels.values()].some((p) => p.panel.active);
  }

  open(viewId: string): void {
    const existing = this.panels.get(viewId);
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
    this.attach(panel, viewId);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: TableWebviewState | undefined): Promise<void> {
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
    const existing = this.panels.get(viewId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    if (!this.sessions.session(viewId)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("View '{0}' is not available.", viewId));
      return;
    }
    this.panels.delete(table.viewId);
    table.retarget(viewId);
    this.panels.set(viewId, table);
  }

  private attach(panel: vscode.WebviewPanel, viewId: string): void {
    const table = new TablePanel(panel, viewId, this.extension.extensionUri, this);
    this.panels.set(viewId, table);
    panel.onDidChangeViewState(() => this.activeChanged.fire());
    panel.onDidDispose(() => {
      table.dispose();
      if (this.panels.get(table.viewId) === table) this.panels.delete(table.viewId);
      this.activeChanged.fire();
    });
    this.activeChanged.fire();
  }

  /** Shared dependencies for each TablePanel. */
  get deps() {
    return {
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
  private readonly messenger = new Messenger();
  private readonly participant;
  private snapshots = new Map<string, SectionSnapshot>();
  private resources = new Map<string, Map<string, KubeResource>>();
  private openSections = new Set<string>();
  private detailsKey: string | undefined;
  private readonly relatedNodes = new Map<string, { resource: KubeResource; children: readonly ChildDefinition[] }>();
  private dirty = false;
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
      m.onRequest(TableRequests.getViewModel, () => this.model()),
      m.onRequest(TableRequests.commandsFor, ({ sectionId, uids }) => this.commandsFor(sectionId, uids)),
      m.onRequest(TableRequests.pickCommand, ({ sectionId, uids }) => this.pickCommand(sectionId, uids)),
      m.onRequest(TableRequests.runCommand, async ({ commandId, sectionId, uids }) => {
        const command = d.commands.get(commandId);
        if (!command || !this.commandsFor(sectionId, uids).some((c) => c.id === commandId)) return "blocked";
        return d.executor.execute(command, this.resolve(sectionId, uids));
      }),
      m.onRequest(TableRequests.details, (ref) => this.details(ref)),
      m.onRequest(TableRequests.related, ({ key }) => this.related(key)),
      m.onRequest(TableRequests.closeRelated, ({ key, dispose }) => {
        if (dispose && key === this.detailsKey) this.closeDetails();
        else if (this.relatedNodes.has(key)) this.session?.closeNode(key);
      }),
      m.onRequest(TableRequests.openManifest, async (ref) => {
        const [r] = this.resolve(ref.sectionId, [ref.uid]);
        const ctx = d.contexts.current;
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
      d.contexts.onDidChange(() => this.reset()),
      d.sessions.onDidChangeSessions(() => this.reset()),
    );
    this.subscribeSession();
    this.visibilityChanged();
  }

  get viewId(): string {
    return this.currentViewId;
  }

  private get session(): ViewSession | undefined {
    return this.owner.deps.sessions.session(this.viewId);
  }

  /** Switch a tab's view: release the old view's leases, then send a new model (the webview discards old view preferences). */
  retarget(viewId: string): void {
    this.closeSections();
    this.owner.deps.sessions.setTableVisible(this.viewId, false);
    this.currentViewId = viewId;
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
    } else if ("allNamespaces" in action) await d.contexts.selectNamespace({ type: "all" });
    else if ("namespace" in action) await d.contexts.selectNamespace({ type: "single", name: action.namespace });
    else if ("command" in action) {
      const command = d.commands.get(action.command);
      if (!command) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Unknown command '{0}'", action.command));
        return;
      }
      await d.executor.execute(command, this.resolve(sectionId, uids));
    } else if (action.action === "runLast") {
      if (!d.executor.lastRun) {
        void vscode.window.showInformationMessage(vscode.l10n.t("No command has been run yet."));
        return;
      }
      const targets = this.resolve(sectionId, uids);
      await d.executor.runLast(targets.length > 0 ? targets : undefined);
    } else if (action.action === "pickNamespace") await vscode.commands.executeCommand("k8sView.selectNamespace");
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
    this.owner.deps.sessions.setTableVisible(this.viewId, false);
    for (const d of this.disposables) d.dispose();
  }

  private sessionSubscription: vscode.Disposable | undefined;

  private subscribeSession(): void {
    this.sessionSubscription?.dispose();
    const session = this.session;
    this.sessionSubscription = session?.onDidChange(() => this.update());
    if (this.sessionSubscription) this.disposables.push(this.sessionSubscription);
  }

  private visibilityChanged(): void {
    const visible = this.panel.visible;
    this.owner.deps.sessions.setTableVisible(this.viewId, visible);
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
    const ctx = this.owner.deps.contexts.current;
    const now = Date.now();
    this.snapshots = new Map();
    this.resources = new Map();
    const sections = (session?.sections() ?? []).map((def) => {
      this.openSections.add(def.id);
      const content = session!.openSection(def.id, "table");
      const built = buildSection(def, content, ctx?.scope.type === "all", now);
      this.snapshots.set(def.id, diffSection(def.id, EMPTY_SNAPSHOT, built).snapshot);
      this.resources.set(def.id, new Map(content.items.map((r) => [r.uid, r])));
      return built;
    });
    this.dirty = false;
    return {
      viewId: this.viewId,
      title: session?.definition.title ?? this.viewId,
      context: ctx?.name,
      scope: ctx?.scope,
      sections,
      prefs: this.owner.deps.state.getWorkspace<Record<string, SectionPrefs>>(prefsKey(this.viewId)) ?? {},
      hotkeys: this.owner.deps.hotkeys.state(),
    };
  }

  private reset(): void {
    this.closeDetails();
    this.subscribeSession();
    const session = this.session;
    if (session) this.panel.title = `${session.definition.title} · table`;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    this.messenger.sendNotification(TableNotifications.reset, this.participant, this.model());
  }

  private update(): void {
    const session = this.session;
    if (!session) return;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    const ctx = this.owner.deps.contexts.current;
    if (this.detailsKey)
      this.messenger.sendNotification(TableNotifications.relatedChanged, this.participant, undefined);
    const now = Date.now();
    const defs = session.sections();
    if (defs.map((d) => d.id).join("\n") !== [...this.snapshots.keys()].join("\n")) {
      this.reset();
      return;
    }
    for (const def of defs) {
      const content = session.openSection(def.id, "table");
      this.openSections.add(def.id);
      const built = buildSection(def, content, ctx?.scope.type === "all", now);
      const { patch, snapshot, changed } = diffSection(def.id, this.snapshots.get(def.id) ?? EMPTY_SNAPSHOT, built);
      this.snapshots.set(def.id, snapshot);
      this.resources.set(def.id, new Map(content.items.map((r) => [r.uid, r])));
      if (changed) this.messenger.sendNotification(TableNotifications.patch, this.participant, patch);
    }
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
    const context = this.owner.deps.contexts.current;
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
    if (!picked?.action || context !== this.owner.deps.contexts.current) return undefined;
    if (picked.action === "details") return "details";
    const current = this.commandsFor(sectionId, uids).find((c) => `command:${c.id}` === picked.action);
    const command = current && !current.blocked ? this.owner.deps.commands.get(current.id) : undefined;
    if (command) await this.owner.deps.executor.execute(command, this.resolve(sectionId, uids));
    return undefined;
  }

  private closeDetails(): void {
    if (this.detailsKey) this.session?.closeNode(this.detailsKey);
    this.detailsKey = undefined;
    this.relatedNodes.clear();
  }

  private related(key: string): RelatedGroup[] {
    const node = this.relatedNodes.get(key);
    const session = this.session;
    if (!node || !session) return [];
    const ctx = this.owner.deps.contexts.current;
    if (!ctx) return [];
    const resource =
      this.owner.deps.source
        .lookup(ctx)
        .list(node.resource.kind.group, node.resource.kind.kind, node.resource.namespace)
        ?.find((r) => r.uid === node.resource.uid) ?? node.resource;
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
    const ctx = d.contexts.current;
    if (!r || !session || !ctx) return { overview: [], yaml: "", events: [], conditions: [], related: [] };
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
    return {
      overview,
      yaml: stringify(r.object, { lineWidth: 0 }),
      events,
      conditions: r.conditions.map((c) => ({ ...c })),
      related,
    };
  }
}
