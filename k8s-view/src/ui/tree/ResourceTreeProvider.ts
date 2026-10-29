import * as vscode from "vscode";
import type { ViewSession } from "../../app/ViewSession";
import type { ViewSessionManager } from "../../app/ViewSessionManager";
import { formatAge } from "../../core/resource/format";
import type { KubeResource } from "../../core/resource/KubeResource";
import { LEVEL_LABEL, levelColor, resourceIcon } from "../icons";
import type { PortForwardInfo } from "../portForward";
import {
  CONTAINER_SUFFIX,
  FIELD_CONTEXT_PREFIX,
  PORT_FORWARD_CONTEXT,
  RESOURCE_CONTEXT_PREFIX,
  type TreeNode,
} from "./TreeNode";

const AGE_REFRESH_MS = 60_000;

/** Active port-forward source (PortForwardManager) for views with `portForwards: true`. */
export interface PortForwardSource {
  readonly onDidChange: vscode.Event<void>;
  list(context?: string): PortForwardInfo[];
}

/**
 * Selected view tree: section → resource → children by relation. Acquire leases when nodes expand (getChildren)
 * and release them on collapse; switching views redraws the tree with the new session.
 */
export class ResourceTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly errorsBySection = new Map<string, number>();
  private readonly badgeChanged = new vscode.EventEmitter<number>();
  /** Number of error resources in open sections (TreeView.badge). */
  readonly onDidChangeErrorCount = this.badgeChanged.event;
  private sessionSubscriptions: vscode.Disposable[] = [];
  private readonly ageTimer = setInterval(() => this.changed.fire(undefined), AGE_REFRESH_MS);
  private readonly managerSubscriptions: vscode.Disposable[];

  constructor(
    private readonly sessions: ViewSessionManager,
    private currentViewId: string | undefined,
    private readonly portForwards?: PortForwardSource,
  ) {
    this.managerSubscriptions = [
      sessions.onDidChangeSessions(() => this.subscribe()),
      ...(portForwards ? [portForwards.onDidChange(() => this.changed.fire(undefined))] : []),
    ];
    this.subscribe();
  }

  get viewId(): string | undefined {
    return this.currentViewId;
  }

  setView(viewId: string | undefined): void {
    if (this.currentViewId === viewId) return;
    this.currentViewId = viewId;
    this.errorsBySection.clear();
    this.subscribe();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.type) {
      case "section": {
        const session = this.sessions.session(node.viewId);
        const def = session?.sectionDefinition(node.sectionId);
        // Single-section views (e.g. "Single resource kind"): expand by default.
        const only = session?.sections().length === 1;
        const item = new vscode.TreeItem(
          def?.title ?? node.sectionId,
          only ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon(def?.icon ?? "folder");
        item.contextValue = "k8sview.section";
        const errors = this.errorsBySection.get(`${node.viewId}/${node.sectionId}`) ?? 0;
        if (errors > 0) item.description = `${errors} error${errors > 1 ? "s" : ""}`;
        return withId(item, node.key);
      }
      case "group": {
        const item = new vscode.TreeItem(node.group || "(none)", vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.errors > 0 ? `${node.count} · ${node.errors} errors` : String(node.count);
        item.iconPath = new vscode.ThemeIcon("symbol-folder");
        item.contextValue = "k8sview.group";
        return withId(item, node.key);
      }
      case "resource":
        return withId(this.resourceItem(node), node.key);
      case "folder": {
        const item = new vscode.TreeItem(node.child.title ?? node.child.id, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = String(node.count);
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "k8sview.folder";
        return withId(item, node.key);
      }
      case "field": {
        const item = new vscode.TreeItem(node.item.label, vscode.TreeItemCollapsibleState.None);
        if (node.item.description) item.description = node.item.description;
        item.iconPath = new vscode.ThemeIcon(node.item.icon ?? "symbol-field");
        const p = node.item.parent;
        item.contextValue = `${FIELD_CONTEXT_PREFIX}${p.kind.group}/${p.kind.kind}${isContainerField(node.item) ? CONTAINER_SUFFIX : ""}`;
        item.tooltip = node.item.description ?? node.item.label;
        return withId(item, node.key);
      }
      case "missing": {
        const item = new vscode.TreeItem(`${node.item.kind} ${node.item.name}`, vscode.TreeItemCollapsibleState.None);
        item.description = "not found";
        item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
        item.contextValue = "k8sview.missing";
        return withId(item, node.key);
      }
      case "message": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.tooltip) item.tooltip = node.tooltip;
        item.contextValue = "k8sview.message";
        return withId(item, node.key);
      }
      case "portForwards": {
        const count = this.portForwardList().length;
        const item = new vscode.TreeItem("Port-forwards", vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("plug");
        item.description = String(count);
        item.contextValue = "k8sview.portForwards";
        item.tooltip = "Port-forwards running on this context (kubectl port-forward)";
        return withId(item, node.key);
      }
      case "portForward":
        return withId(portForwardItem(node.info), node.key);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.roots();
    const session = this.sessions.session(node.viewId);
    if (!session) return [];
    switch (node.type) {
      case "portForwards": {
        const list = this.portForwardList();
        if (list.length === 0)
          return [message(node, "empty", "None — use Port-forward… on a Service or Pod", "circle-slash")];
        return list.map((info) => ({ type: "portForward", key: `${node.key}/${info.id}`, viewId: node.viewId, info }));
      }
      case "section":
        return this.sectionChildren(session, node.sectionId, node.key);
      case "group":
        return this.groupChildren(session, node);
      case "resource":
        return this.resourceChildren(session, node);
      case "folder": {
        const [content] = session.openChildren(node.key, node.parent, [node.child]);
        if (!content) return [];
        return [
          ...content.hints.map((h, i) => message(node, `hint-${i}`, h, "info")),
          ...this.childItems(node, node.child.children, content.items, node.sectionId),
          ...(content.pending ? [message(node, "loading", "Loading…", "loading~spin")] : []),
        ];
      }
      default:
        return [];
    }
  }

  getParent(): undefined {
    return undefined;
  }

  /** Collapse: release the node's leases and those of all descendants. */
  collapsed(node: TreeNode): void {
    const session = this.sessions.session(node.viewId);
    if (!session) return;
    if (node.type === "section") {
      session.closeSection(node.sectionId);
      session.closeNode(node.key);
      this.errorsBySection.delete(`${node.viewId}/${node.sectionId}`);
      this.emitErrorCount();
    } else if (node.type === "resource" || node.type === "folder" || node.type === "group") {
      session.closeNode(node.key);
    }
  }

  dispose(): void {
    clearInterval(this.ageTimer);
    for (const d of this.sessionSubscriptions) d.dispose();
    for (const d of this.managerSubscriptions) d.dispose();
    this.changed.dispose();
    this.badgeChanged.dispose();
  }

  private subscribe(): void {
    for (const d of this.sessionSubscriptions) d.dispose();
    const session = this.sessions.session(this.currentViewId ?? "");
    this.sessionSubscriptions = session ? [session.onDidChange(() => this.changed.fire(undefined))] : [];
    this.changed.fire(undefined);
  }

  private roots(): TreeNode[] {
    const session = this.sessions.session(this.currentViewId ?? "");
    return session ? this.sectionNodes(session) : [];
  }

  private sectionNodes(session: ViewSession): TreeNode[] {
    const viewId = session.definition.id;
    if (!session.context) return [];
    if (!session.available) {
      return [
        {
          type: "message",
          key: "unavailable",
          viewId,
          text: "Required API groups are not served by this cluster",
          icon: "info",
        },
      ];
    }
    const sections = session.sections();
    const portForwards: TreeNode[] =
      session.definition.portForwards && this.portForwards
        ? [{ type: "portForwards", key: "port-forwards", viewId }]
        : [];
    if (sections.length === 0) {
      const text = session.resolved
        ? "None of the kinds of this view are served by this cluster"
        : "Discovering resource kinds…";
      return [
        ...portForwards,
        { type: "message", key: "no-sections", viewId, text, icon: session.resolved ? "info" : "loading~spin" },
      ];
    }
    return [
      ...portForwards,
      ...sections.map((s): TreeNode => ({ type: "section", key: s.id, viewId, sectionId: s.id })),
    ];
  }

  private portForwardList(): PortForwardInfo[] {
    const ctx = this.sessions.session(this.currentViewId ?? "")?.context;
    return ctx ? (this.portForwards?.list(ctx.name) ?? []) : [];
  }

  private sectionChildren(session: ViewSession, sectionId: string, key: string): TreeNode[] {
    const section = session.sectionDefinition(sectionId);
    if (!section) return [];
    const content = session.openSection(sectionId);
    const viewId = session.definition.id;
    const parent = { key, viewId };
    const problems = content.problems.map((p, i) =>
      message(
        parent,
        `problem-${i}`,
        `${p.kind}: ${p.state === "forbidden" ? "no permission to list" : (p.message ?? p.state)}`,
        p.state === "forbidden" ? "lock" : "error",
        p.message,
      ),
    );
    this.errorsBySection.set(
      `${viewId}/${sectionId}`,
      content.items.filter((r) => section.status(r).level === "error").length,
    );
    this.emitErrorCount();
    if (content.state === "loading") return [...problems, message(parent, "loading", "Loading…", "loading~spin")];
    if (content.groups) {
      return [
        ...problems,
        ...content.groups.map(
          (g): TreeNode => ({
            type: "group",
            key: `${key}/group:${g.key}`,
            viewId,
            sectionId,
            group: g.key,
            count: g.items.length,
            errors: g.items.filter((r) => section.status(r).level === "error").length,
          }),
        ),
      ];
    }
    if (content.items.length === 0 && problems.length === 0)
      return [message(parent, "empty", "No resources", "circle-slash")];
    return [
      ...problems,
      ...content.items.map((r) => this.resourceNode(viewId, key, r, section, section.children, sectionId)),
    ];
  }

  private groupChildren(session: ViewSession, node: Extract<TreeNode, { type: "group" }>): TreeNode[] {
    const section = session.sectionDefinition(node.sectionId);
    if (!section) return [];
    const group = session.openSection(node.sectionId).groups?.find((g) => g.key === node.group);
    return (group?.items ?? []).map((r) =>
      this.resourceNode(node.viewId, node.key, r, section, section.children, node.sectionId),
    );
  }

  private resourceChildren(session: ViewSession, node: Extract<TreeNode, { type: "resource" }>): TreeNode[] {
    const contents = session.openChildren(node.key, node.resource, node.children);
    const out: TreeNode[] = [];
    for (const content of contents) {
      out.push(...content.hints.map((h, i) => message(node, `${content.def.id}/hint-${i}`, h, "info")));
      if (content.def.title) {
        out.push({
          type: "folder",
          key: `${node.key}/${content.def.id}`,
          viewId: node.viewId,
          parent: node.resource,
          child: content.def,
          count: content.items.length,
          sectionId: node.sectionId,
        });
        continue;
      }
      out.push(...this.childItems(node, content.def.children, content.items, node.sectionId, content.def));
      if (content.pending) out.push(message(node, `${content.def.id}/loading`, "Loading…", "loading~spin"));
    }
    return out;
  }

  private childItems(
    parent: { key: string; viewId: string },
    grandChildren: Extract<TreeNode, { type: "resource" }>["children"],
    items: ReturnType<ViewSession["openChildren"]>[number]["items"],
    sectionId: string,
    def?: Extract<TreeNode, { type: "resource" }>["definition"],
  ): TreeNode[] {
    return items.map((item): TreeNode => {
      if (item.type === "resource") {
        const definition = def ?? this.sessions.session(parent.viewId)?.sectionDefinition(sectionId);
        return this.resourceNode(parent.viewId, parent.key, item.resource, definition!, grandChildren, sectionId);
      }
      if (item.type === "field")
        return { type: "field", key: `${parent.key}/field:${item.key ?? item.index}`, viewId: parent.viewId, item };
      return {
        type: "missing",
        key: `${parent.key}/missing:${item.kind}/${item.namespace ?? ""}/${item.name}`,
        viewId: parent.viewId,
        item,
      };
    });
  }

  private resourceNode(
    viewId: string,
    parentKey: string,
    resource: KubeResource,
    definition: Extract<TreeNode, { type: "resource" }>["definition"],
    children: Extract<TreeNode, { type: "resource" }>["children"],
    sectionId: string,
  ): TreeNode {
    return { type: "resource", key: `${parentKey}/${resource.uid}`, viewId, resource, definition, children, sectionId };
  }

  private resourceItem(node: Extract<TreeNode, { type: "resource" }>): vscode.TreeItem {
    const r = node.resource;
    const now = Date.now();
    const status = node.definition.status(r);
    const visibleChildren = node.children.filter((c) => !c.hidden);
    const item = new vscode.TreeItem(
      node.definition.label(r),
      visibleChildren.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    const session = this.sessions.session(node.viewId);
    const section = session?.sectionDefinition(node.sectionId);
    const showNamespace =
      (session?.context?.scope.type === "all" || (node.definition === section && section?.allNamespaces)) &&
      r.namespace;
    const description = node.definition.describe(r, now);
    // Errors: show the reason (e.g. ArtifactFailed) even if the description template omits it, e.g. an empty revision.
    const reason =
      status.level === "error" && status.summary && !description.includes(status.summary) ? status.summary : undefined;
    item.description = [showNamespace ? r.namespace : undefined, reason, description].filter(Boolean).join(" · ");
    item.iconPath = resourceIcon(
      r.kind.key,
      status.level,
      node.definition === section ? section?.icon : undefined,
      status,
    );
    item.contextValue = `${RESOURCE_CONTEXT_PREFIX}${r.kind.group}/${r.kind.kind}`;
    item.tooltip = tooltip(r, status.level, status.summary, now);
    item.accessibilityInformation = {
      label: `${r.kind.kind} ${r.name}, ${LEVEL_LABEL[status.level]}${status.summary ? `, ${status.summary}` : ""}`,
    };
    return item;
  }

  private emitErrorCount(): void {
    let total = 0;
    for (const n of this.errorsBySection.values()) total += n;
    this.badgeChanged.fire(total);
  }
}

/** Pod `spec.containers[*]` entry (with `name` and `image`): container "Logs" menu. */
function isContainerField(item: Extract<TreeNode, { type: "field" }>["item"]): boolean {
  const v = item.value as { name?: unknown; image?: unknown } | undefined;
  return (
    item.parent.kind.group === "" &&
    item.parent.kind.kind === "Pod" &&
    typeof v?.name === "string" &&
    typeof v.image === "string"
  );
}

function portForwardItem(info: PortForwardInfo): vscode.TreeItem {
  const r = info.request;
  const item = new vscode.TreeItem(`${r.kind}/${r.name}`, vscode.TreeItemCollapsibleState.None);
  const active = info.state === "active";
  item.description = `${r.ports} · ${r.namespace}${active ? "" : " · starting"}`;
  item.iconPath = active ? new vscode.ThemeIcon("plug", levelColor("ok")) : new vscode.ThemeIcon("loading~spin");
  item.contextValue = PORT_FORWARD_CONTEXT;
  const md = new vscode.MarkdownString("", true);
  md.appendMarkdown(`**Port-forward** \`${r.kind}/${r.name}\`\n\n`);
  md.appendMarkdown(`Namespace: \`${r.namespace}\`  \nPorts: \`${r.ports}\`  \n`);
  md.appendMarkdown(`Local: ${info.localPorts.map((p) => `http://localhost:${p}`).join(", ")}  \n`);
  md.appendMarkdown(`Running for ${formatAge(Date.now() - info.startedAt)}`);
  item.tooltip = md;
  return item;
}

function withId(item: vscode.TreeItem, key: string): vscode.TreeItem {
  item.id = key;
  return item;
}

function message(
  parent: { key: string; viewId: string },
  id: string,
  text: string,
  icon: string,
  tooltip?: string,
): TreeNode {
  return {
    type: "message",
    key: `${parent.key}/${id}`,
    viewId: parent.viewId,
    text,
    icon,
    ...(tooltip ? { tooltip } : {}),
  };
}

function tooltip(
  r: KubeResource,
  level: Parameters<typeof resourceIcon>[1],
  summary: string | undefined,
  now: number,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.appendMarkdown(`**${r.kind.kind}** \`${r.name}\`\n\n`);
  if (r.namespace) md.appendMarkdown(`Namespace: \`${r.namespace}\`  \n`);
  md.appendMarkdown(`Status: ${LEVEL_LABEL[level]}${summary ? ` — ${escapeMarkdown(summary)}` : ""}  \n`);
  const age = r.ageMs(now);
  if (age !== undefined) md.appendMarkdown(`Age: ${formatAge(age)}  \n`);
  const labels = Object.entries(r.labels);
  if (labels.length > 0) md.appendMarkdown(`\nLabels: ${labels.map(([k, v]) => `\`${k}=${v}\``).join(" ")}\n`);
  const images = imagesOf(r);
  if (images.length > 0) md.appendMarkdown(`\nImages: ${images.map((i) => `\`${i}\``).join(", ")}\n`);
  if (r.conditions.length > 0) {
    md.appendMarkdown("\n| Condition | Status | Reason | Message |\n|---|---|---|---|\n");
    for (const c of r.conditions)
      md.appendMarkdown(
        `| ${escapeMarkdown(c.type)} | ${escapeMarkdown(c.status)} | ${escapeMarkdown(c.reason ?? "")} | ${escapeMarkdown(c.message ?? "").replace(/\n/g, " ")} |\n`,
      );
  }
  return md;
}

function imagesOf(r: KubeResource): string[] {
  const spec = r.object["spec"] as
    | { containers?: { image?: string }[]; template?: { spec?: { containers?: { image?: string }[] } } }
    | undefined;
  const containers = spec?.containers ?? spec?.template?.spec?.containers ?? [];
  return containers.map((c) => c.image ?? "").filter(Boolean);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[|\\`*_{}[\]<>]/g, (c) => `\\${c}`);
}
