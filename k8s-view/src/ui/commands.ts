import * as vscode from "vscode";
import type { CommandExecutor } from "../app/CommandExecutor";
import type { CommandRegistry } from "../app/CommandRegistry";
import { type ContextService, errorMessage } from "../app/ContextService";
import type { HotkeyService } from "../app/HotkeyService";
import type { KindViewService } from "../app/KindViewService";
import { logTargetFor } from "../app/LogSession";
import type { ResourceSource } from "../app/ports/ResourceSource";
import type { Settings } from "../app/ports/Settings";
import type { ViewRegistry } from "../app/ViewRegistry";
import type { ViewSessionManager } from "../app/ViewSessionManager";
import type { CommandDefinition } from "../core/command/CommandDefinition";
import { ClusterContext, isProtectedContext, scopeLabel } from "../core/context/ClusterContext";
import { ExpressionEngine, stringify } from "../core/expression/ExpressionEngine";
import { matchesAnnotations, parseAnnotationFilter } from "../core/resource/annotationFilter";
import { formatAge } from "../core/resource/format";
import { isSecretKind, type KubeResource } from "../core/resource/KubeResource";
import { httpRouteUrls, ingressUrls, parentGateways } from "../core/resource/routeUrls";
import { StatusEvaluator } from "../core/view/StatusEvaluator";
import type { ConfigLoader } from "../infra/config/ConfigLoader";
import type { KubernetesExtensionGateway } from "../infra/ms-kubernetes/KubernetesExtensionGateway";
import type { ConfigWriter } from "./ConfigWriter";
import type { HelmValuesDocumentProvider, HelmValuesKind } from "./HelmValuesDocumentProvider";
import type { LogTerminals } from "./LogTerminals";
import type { DescribeDocumentProvider, ManifestDocumentProvider } from "./ManifestDocumentProvider";
import type { PortForwardManager, PortForwardRequest } from "./PortForwardManager";
import { isRefArg, type ResourceRefArg } from "./ResourceRefs";
import type { SecretDocumentProvider } from "./SecretDocumentProvider";
import { createSnippetWizard } from "./SnippetWizard";
import type { SnippetNode } from "./tree/SnippetTreeProvider";
import type { TreeNode } from "./tree/TreeNode";
import type { TreeViewManager } from "./tree/TreeViewManager";
import type { ResourceTablePanels } from "./webview/ResourceTablePanel";

export interface CommandDeps {
  readonly contexts: ContextService;
  readonly source: ResourceSource;
  readonly settings: Settings;
  readonly views: ViewRegistry;
  readonly sessions: ViewSessionManager;
  readonly commands: CommandRegistry;
  readonly executor: CommandExecutor;
  readonly trees: TreeViewManager;
  readonly tables: ResourceTablePanels;
  readonly manifests: ManifestDocumentProvider;
  readonly describe: DescribeDocumentProvider;
  readonly portForwards: PortForwardManager;
  readonly writer: ConfigWriter;
  readonly gateway: KubernetesExtensionGateway;
  readonly logs: LogTerminals;
  readonly secrets: SecretDocumentProvider;
  readonly helmValues: HelmValuesDocumentProvider;
  readonly kindView: KindViewService;
  readonly loader: ConfigLoader;
  readonly hotkeys: HotkeyService;
}

type ResourceNode = Extract<TreeNode, { type: "resource" }>;
type FieldNode = Extract<TreeNode, { type: "field" }>;

const isResourceNode = (v: unknown): v is ResourceNode =>
  !!v && typeof v === "object" && (v as TreeNode).type === "resource";
const isFieldNode = (v: unknown): v is FieldNode => !!v && typeof v === "object" && (v as TreeNode).type === "field";
const isSnippetNode = (v: unknown): v is Extract<SnippetNode, { type: "snippet" }> =>
  !!v && typeof v === "object" && (v as SnippetNode).type === "snippet";
const isPortForwardNode = (v: unknown): v is Extract<TreeNode, { type: "portForward" }> =>
  !!v && typeof v === "object" && (v as TreeNode).type === "portForward";

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        void vscode.window.showErrorMessage(errorMessage(e));
      }
    });

  return [
    // Context panel calls with `{ namespaceStep: false }`: it has a separate namespace picker directly below.
    reg("k8sView.selectContext", (arg) =>
      selectContext(d, (arg as { namespaceStep?: unknown } | undefined)?.namespaceStep !== false),
    ),
    reg("k8sView.selectNamespace", () => selectNamespace(d)),
    reg("k8sView.reconnect", () => reconnect(d)),
    reg("k8sView.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:yunerou.k8s-view"),
    ),
    reg("k8sView.reloadRemoteConfigs", () => reloadRemoteConfigs(d)),
    reg("k8sView.runCommand", (arg, selection) => runCommand(d, arg, selection)),
    reg("k8sView.runLastCommand", async (arg, selection) => {
      if (!d.executor.lastRun) {
        void vscode.window.showInformationMessage(vscode.l10n.t("No command has been run yet."));
        return;
      }
      const targets = resourceTargets(arg, selection);
      await d.executor.runLast(targets.length > 0 ? targets : undefined);
    }),
    reg("k8sView.runSnippet", () => runSnippet(d)),
    reg("k8sView.toggleHotkeys", () => d.hotkeys.toggle()),
    reg("k8sView.runSnippetItem", async (node) => {
      const command = isSnippetNode(node) ? d.commands.get(node.id) : undefined;
      if (command) await d.executor.execute(command, []);
    }),
    reg("k8sView.createSnippet", () => createSnippetWizard(d)),
    reg("k8sView.editSnippet", async (node) => {
      const location = isSnippetNode(node) ? d.commands.locationOf(node.id) : undefined;
      if (location) await d.writer.editCommand(location);
    }),
    reg("k8sView.deleteSnippet", (node) => (isSnippetNode(node) ? deleteSnippet(d, node.id) : undefined)),
    reg("k8sView.logs", (arg, container) => openLogs(d, arg, typeof container === "string" ? container : undefined)),
    reg("k8sView.containerLogs", (node) => {
      if (!isFieldNode(node)) return;
      const name = (node.item.value as { name?: unknown } | undefined)?.name;
      const ctx = d.contexts.current;
      const target = ctx && typeof name === "string" ? logTargetFor(ctx, node.item.parent, name) : undefined;
      if (target) d.logs.open(target);
    }),
    reg("k8sView.decodeSecret", async (arg) => {
      const ref = toRef(d, arg);
      if (ref) await d.secrets.open(ref);
    }),
    // Context menu items call built-in JSON commands (still subject to the dangerous command policy).
    reg("k8sView.rolloutRestart", (arg, selection) => runBuiltin(d, "workload.restart", arg, selection)),
    reg("k8sView.portForwardResource", (arg, selection) => runBuiltin(d, "pod.portForward", arg, selection)),
    reg("k8sView.nodeCordon", (arg, selection) => runBuiltin(d, "node.cordon", arg, selection)),
    reg("k8sView.nodeUncordon", (arg, selection) => runBuiltin(d, "node.uncordon", arg, selection)),
    reg("k8sView.nodeDrain", (arg, selection) => runBuiltin(d, "node.drain", arg, selection)),
    reg("k8sView.openInBrowser", (arg) => openInBrowser(d, arg)),
    reg("k8sView.helmShowValues", (arg) => showHelmValues(d, arg, "values")),
    reg("k8sView.helmShowDefaultValues", (arg) => showHelmValues(d, arg, "defaults")),
    reg("k8sView.findPods", (arg) => findPods(d, arg)),
    reg("k8sView.stopPortForward", (node) => {
      if (isPortForwardNode(node)) d.portForwards.stop(node.info.id);
    }),
    reg("k8sView.openPortForward", (node) =>
      isPortForwardNode(node) ? d.portForwards.openInBrowser(node.info.id) : undefined,
    ),
    reg("k8sView.portForwardOutput", () => d.portForwards.showOutput()),
    reg("k8sView.selectKind", () => selectKind(d)),
    reg("k8sView.listCrdInstances", (arg) => listCrdInstances(d, arg)),
    reg("k8sView.manageViews", () => manageViews(d)),
    reg("k8sView.configureFavoriteViews", () => configureFavoriteViews(d)),
    reg("k8sView.switchView", () => switchView(d)),
    reg("k8sView.refresh", () => {
      const ctx = d.contexts.current;
      if (ctx) d.source.resync(ctx);
      for (const s of d.sessions.all()) s.update(s.view);
      void d.contexts.checkConnection();
    }),
    reg("k8sView.pause", () => d.source.setPaused(true)),
    reg("k8sView.resume", () => d.source.setPaused(false)),
    reg("k8sView.toggleAutoRefresh", () => d.source.setPaused(!d.source.paused)),
    reg("k8sView.openTable", async (arg) => {
      const viewId = typeof arg === "string" ? arg : await pickView(d, vscode.l10n.t("Open which view as a table?"));
      if (viewId) d.tables.open(viewId);
    }),
    reg("k8sView.editViewConfig", async (arg) => {
      const viewId = typeof arg === "string" ? arg : await pickView(d, vscode.l10n.t("Edit which view?"));
      const view = viewId ? d.views.get(viewId) : undefined;
      if (view) await editView(d, view.id);
    }),
    reg("k8sView.createCustomView", () => createCustomView(d)),
    reg("k8sView.openManifest", async (arg) => {
      const ref = toRef(d, arg);
      if (ref) await d.manifests.open(ref);
    }),
    reg("k8sView.describe", async (arg) => {
      const ref = toRef(d, arg);
      if (ref) await d.describe.open(ref);
    }),
    reg("k8sView.copyToClipboard", async (text) => {
      await vscode.env.clipboard.writeText(String(text ?? ""));
      void vscode.window.setStatusBarMessage(vscode.l10n.t("Copied to clipboard"), 2000);
    }),
    reg("k8sView.portForward", (arg) => {
      if (arg && typeof arg === "object") d.portForwards.start(arg as PortForwardRequest);
    }),
    reg("k8sView.portForwards", () => d.portForwards.pick()),
    reg("k8sView.copyFieldValue", async (node) => {
      if (!isFieldNode(node)) return;
      if (isSecretKind(node.item.parent.kind)) return copySecret(d, node);
      await vscode.env.clipboard.writeText(
        typeof node.item.value === "string" ? node.item.value : stringify(node.item.value),
      );
      void vscode.window.setStatusBarMessage(vscode.l10n.t("Copied {0}", node.item.label), 2000);
    }),
    reg("k8sView.copySecretValue", (node) => (isFieldNode(node) ? copySecret(d, node) : undefined)),
    reg("k8sView.revealSecretValue", async (node) => {
      if (!isFieldNode(node) || !node.item.key) return;
      const ctx = d.contexts.current;
      const p = node.item.parent;
      if (!ctx || !p.namespace) return;
      const value = await d.source.readSecretValue(ctx, p.namespace, p.name, node.item.key);
      const copy = vscode.l10n.t("Copy");
      const answer = await vscode.window.showInformationMessage(
        `${p.name} / ${node.item.key}`,
        { modal: true, detail: value },
        copy,
      );
      if (answer === copy) await vscode.env.clipboard.writeText(value);
    }),
  ];
}

/** Run JSON command `id` on the tree's selected resource (a kind-specific context menu item). */
async function runBuiltin(d: CommandDeps, id: string, arg: unknown, selection: unknown): Promise<void> {
  const command = d.commands.get(id);
  if (!command?.config.enabled) {
    void vscode.window.showInformationMessage(vscode.l10n.t("The '{0}' command is disabled.", id));
    return;
  }
  const targets = resourceTargets(arg, selection);
  if (targets.length > 0) await d.executor.execute(command, targets);
}

/** Fresh API resource (tree node or `{ context, group, kind, namespace, name }` reference). */
async function resolveResource(
  d: CommandDeps,
  arg: unknown,
): Promise<{ resource: KubeResource; context: ClusterContext } | undefined> {
  const current = d.contexts.current;
  if (isResourceNode(arg)) return current ? { resource: arg.resource, context: current } : undefined;
  if (!isRefArg(arg)) return undefined;
  const ctx =
    current?.name === arg.context
      ? current
      : new ClusterContext(
          arg.context,
          "",
          "",
          arg.namespace ? { type: "single", name: arg.namespace } : { type: "all" },
          isProtectedContext(arg.context, d.settings.protectedContexts()),
        );
  const kind = await d.source.resolveKind(ctx, arg);
  if (!kind) throw new Error(vscode.l10n.t("{0} is not served by context {1}", arg.kind, arg.context));
  return { resource: await d.source.get(ctx, kind, arg.namespace || undefined, arg.name), context: ctx };
}

/** HTTPRoute/Ingress "Open in browser": read parent Gateways for HTTPS/port; prompt if there are multiple URLs. */
async function openInBrowser(d: CommandDeps, arg: unknown): Promise<void> {
  const resolved = await resolveResource(d, arg);
  if (!resolved) return;
  const { resource, context } = resolved;
  let urls: string[];
  if (resource.kind.key === "gateway.networking.k8s.io/HTTPRoute") {
    const gatewayKind = await d.source.resolveKind(context, { group: "gateway.networking.k8s.io", kind: "Gateway" });
    const gateways = gatewayKind
      ? await Promise.all(
          parentGateways(resource.object).map((g) =>
            d.source.get(context, gatewayKind, g.namespace, g.name).then(
              (r) => r.object,
              () => undefined,
            ),
          ),
        )
      : [];
    urls = httpRouteUrls(
      resource.object,
      gateways.filter((g) => g !== undefined),
    );
  } else if (resource.kind.key === "networking.k8s.io/Ingress") {
    urls = ingressUrls(resource.object);
  } else {
    throw new Error(vscode.l10n.t("Open in browser works on HTTPRoutes and Ingresses"));
  }
  if (urls.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("{0} {1} has no hostname or address to open.", resource.kind.kind, resource.name),
    );
    return;
  }
  const picked =
    urls.length === 1
      ? urls[0]
      : await vscode.window.showQuickPick(urls, { title: vscode.l10n.t("Open {0} in browser", resource.name) });
  if (picked) await vscode.env.openExternal(vscode.Uri.parse(picked));
}

async function showHelmValues(d: CommandDeps, arg: unknown, which: HelmValuesKind): Promise<void> {
  const ref = toRef(d, arg);
  if (ref) await d.helmValues.open(ref, which);
}

interface FindPodsArgs {
  readonly context?: string;
  readonly namespace?: string;
  readonly labelSelector?: string;
  readonly annotation?: string;
}

const podStatus = new StatusEvaluator(new ExpressionEngine("safe"));
const FIND_PODS_SNIPPET = "snippet.findPods";

/**
 * "Find pods" snippet: list Pods by label selector (server-side) and annotations (client-side, unsupported by the API), in
 * the selected namespace or all namespaces; select a pod to run its commands.
 */
async function findPods(d: CommandDeps, arg: unknown): Promise<void> {
  // From the Command Palette: run the snippet to prompt for labels/annotations.
  const snippet = d.commands.get(FIND_PODS_SNIPPET);
  if (arg === undefined && snippet) {
    await d.executor.execute(snippet, []);
    return;
  }
  const a = (arg && typeof arg === "object" ? arg : {}) as FindPodsArgs;
  const current = d.contexts.current;
  if (!current) throw new Error(vscode.l10n.t("Select a context first"));
  const ctx = a.context && a.context !== current.name ? undefined : current;
  if (!ctx) throw new Error(vscode.l10n.t("Context {0} is not selected", a.context ?? ""));
  const namespace = a.namespace || undefined;
  const conditions = parseAnnotationFilter(a.annotation ?? "");
  const selector = a.labelSelector?.trim() || undefined;
  const pods = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Listing pods…") },
    () => d.source.listResources(ctx, { group: "", kind: "Pod" }, namespace, selector),
  );
  const found = pods
    .filter((p) => matchesAnnotations(p.annotations, conditions))
    .sort((x, y) => (x.namespace ?? "").localeCompare(y.namespace ?? "") || x.name.localeCompare(y.name));
  const filters = [selector ? `-l ${selector}` : "", conditions.length > 0 ? `annotations ${a.annotation}` : ""]
    .filter(Boolean)
    .join(", ");
  const where = namespace ?? vscode.l10n.t("all namespaces");
  if (found.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No pods in {0} match {1}.", where, filters || "*"));
    return;
  }
  const now = Date.now();
  const picked = await vscode.window.showQuickPick(
    found.map((p) => {
      const status = podStatus.evaluate(p, { preset: "pod" });
      const age = p.ageMs(now);
      const node = (p.object["spec"] as { nodeName?: string } | undefined)?.nodeName;
      const matched = conditions.map((c) => `${c.key}=${p.annotations[c.key] ?? ""}`);
      return {
        label: `$(${status.level === "error" ? "error" : status.level === "ok" ? "pass" : "circle-outline"}) ${p.name}`,
        description: [
          namespace ? undefined : p.namespace,
          status.summary,
          age === undefined ? undefined : formatAge(age),
          node,
        ]
          .filter(Boolean)
          .join(" · "),
        ...(matched.length > 0 ? { detail: matched.join("  ") } : {}),
        pod: p,
      };
    }),
    {
      title: vscode.l10n.t("{0} pods in {1}{2}", found.length, where, filters ? ` (${filters})` : ""),
      placeHolder: vscode.l10n.t("Pick a pod to run a command on it"),
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (picked) await pickAndRun(d, [picked.pod]);
}

/** Pod logs (all containers or one container) or workload logs (all selector-matching pods) in a terminal. */
async function openLogs(d: CommandDeps, arg: unknown, container: string | undefined): Promise<void> {
  let resource: KubeResource | undefined;
  let ctx = d.contexts.current;
  if (isResourceNode(arg)) {
    resource = arg.resource;
  } else if (isRefArg(arg)) {
    const ref = arg as ResourceRefArg & { container?: unknown };
    const name = container ?? (typeof ref.container === "string" && ref.container ? ref.container : undefined);
    if (!ctx || ctx.name !== ref.context) {
      const info = d.contexts.contexts().find((c) => c.name === ref.context);
      ctx = new ClusterContext(
        ref.context,
        info?.cluster ?? "",
        info?.user ?? "",
        ref.namespace ? { type: "single", name: ref.namespace } : { type: "all" },
        isProtectedContext(ref.context, d.settings.protectedContexts()),
      );
    }
    const kind = await d.source.resolveKind(ctx, ref);
    if (!kind) throw new Error(vscode.l10n.t("{0} is not served by context {1}", ref.kind, ref.context));
    resource = await d.source.get(ctx, kind, ref.namespace, ref.name);
    container = name;
  }
  if (!resource || !ctx) return;
  const target = logTargetFor(ctx, resource, container);
  if (!target) {
    void vscode.window.showInformationMessage(vscode.l10n.t("{0} has no logs.", resource.kind.kind));
    return;
  }
  d.logs.open(target);
}

async function deleteSnippet(d: CommandDeps, id: string): Promise<void> {
  const command = d.commands.get(id);
  const location = d.commands.locationOf(id);
  if (!command || !location || (location.origin !== "user" && location.origin !== "workspace")) return;
  const remove = vscode.l10n.t("Delete");
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t("Delete snippet '{0}'?", command.title),
    { modal: true, detail: vscode.Uri.parse(location.fileId).fsPath },
    remove,
  );
  if (answer === remove) await d.writer.deleteCommand(location);
}

async function copySecret(d: CommandDeps, node: FieldNode): Promise<void> {
  const ctx = d.contexts.current;
  const p = node.item.parent;
  if (!ctx || !p.namespace || !node.item.key) return;
  await vscode.env.clipboard.writeText(await d.source.readSecretValue(ctx, p.namespace, p.name, node.item.key));
  void vscode.window.setStatusBarMessage(vscode.l10n.t("Copied decoded value of {0}", node.item.key), 2000);
}

/** Target resources: selected nodes if the clicked node is selected; otherwise only the clicked node. */
function resourceTargets(arg: unknown, selection: unknown): KubeResource[] {
  if (!isResourceNode(arg)) return [];
  const selected = Array.isArray(selection) ? selection.filter(isResourceNode) : [];
  return (selected.some((s) => s.key === arg.key) ? selected : [arg]).map((n) => n.resource);
}

function toRef(d: CommandDeps, arg: unknown): ResourceRefArg | undefined {
  if (isRefArg(arg)) return arg;
  const ctx = d.contexts.current;
  if (isResourceNode(arg) && ctx) {
    const r = arg.resource;
    return { context: ctx.name, group: r.kind.group, kind: r.kind.kind, namespace: r.namespace, name: r.name };
  }
  return undefined;
}

/**
 * Reconnect the selected context. Contexts using exec auth always rerun the plugin in a terminal (passkey/password entry,
 * SSO sign-in); once connected, failed watches/lists restart immediately instead of waiting for backoff.
 */
async function reconnect(d: CommandDeps): Promise<void> {
  const connection = await d.contexts.checkConnection({ reauthenticate: true });
  const ctx = d.contexts.current;
  if (connection.state !== "connected" || !ctx) return;
  d.source.resync(ctx);
  await d.contexts.loadNamespaces().catch(() => undefined);
}

async function selectContext(d: CommandDeps, namespaceStep = true): Promise<void> {
  const current = d.contexts.current?.name;
  const kubeconfigCurrent = d.contexts.kubeconfigCurrentContext();
  const protectedPatterns = d.settings.protectedContexts();
  const picked = await vscode.window.showQuickPick(
    d.contexts.contexts().map((c) => ({
      label: `${isProtectedContext(c.name, protectedPatterns) ? "$(shield) " : ""}${c.name}`,
      description: [
        c.name === current ? "selected" : undefined,
        c.name === kubeconfigCurrent ? "kubectl current" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      detail: `${c.cluster} · ${c.user}`,
      name: c.name,
    })),
    {
      title: namespaceStep
        ? vscode.l10n.t("K8s View: Select context (1/2)")
        : vscode.l10n.t("K8s View: Select context"),
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) return;
  if (picked.name !== current) await d.contexts.selectContext(picked.name);
  if (namespaceStep) await selectNamespace(d, true);
}

async function selectNamespace(d: CommandDeps, step2 = false): Promise<void> {
  const ctx = d.contexts.current;
  if (!ctx) return;
  type Item = vscode.QuickPickItem & { scope?: ClusterContext["scope"] };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = step2 ? vscode.l10n.t("K8s View: Select namespace (2/2)") : vscode.l10n.t("K8s View: Select namespace");
  qp.placeholder = vscode.l10n.t("Current: {0}", scopeLabel(ctx.scope));
  qp.busy = true;
  const base = (names: readonly string[]): Item[] => [
    { label: "$(globe) All namespaces", scope: { type: "all" } },
    ...names.map((n) => ({ label: n, scope: { type: "single" as const, name: n } })),
  ];
  qp.items = base(d.contexts.namespaces.items);
  let forbidden = false;
  void d.contexts.loadNamespaces().then(
    (list) => {
      forbidden = list.forbidden;
      qp.items = base(list.items);
      qp.busy = false;
      if (forbidden) qp.placeholder = vscode.l10n.t("No permission to list namespaces — type a namespace name");
    },
    (e) => {
      qp.busy = false;
      qp.placeholder = errorMessage(e);
    },
  );
  qp.onDidChangeValue((value) => {
    const exists = qp.items.some((i) => i.scope?.type === "single" && i.scope.name === value);
    const typed =
      value && !exists
        ? [
            {
              label: `$(edit) ${value}`,
              description: vscode.l10n.t("use this namespace"),
              scope: { type: "single" as const, name: value },
            },
          ]
        : [];
    qp.items = [...typed, ...base(d.contexts.namespaces.items)];
  });
  const scope = await new Promise<ClusterContext["scope"] | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]?.scope));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (scope) await d.contexts.selectNamespace(scope);
}

async function pickCommand(
  d: CommandDeps,
  list: readonly CommandDefinition[],
  title: string,
): Promise<CommandDefinition | "last" | undefined> {
  type Item = vscode.QuickPickItem & { command?: CommandDefinition; last?: boolean };
  const restricted = d.settings.dangerousCommands() === "restricted";
  const items: Item[] = [];
  const last = d.executor.lastRun;
  if (last && list.some((c) => c.id === last.command.id)) {
    items.push({ label: `$(history) ${vscode.l10n.t("Run last: {0}", last.command.title)}`, last: true });
  }
  let group: string | undefined | null = null;
  for (const c of list) {
    if (c.group !== group) {
      group = c.group;
      items.push({ label: c.group ?? vscode.l10n.t("Other"), kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: `$(${c.icon ?? "play"}) ${c.title}`,
      description: c.dangerous
        ? restricted
          ? vscode.l10n.t("disabled — dangerous (k8sView.commands.dangerous)")
          : vscode.l10n.t("dangerous")
        : undefined,
      detail: c.origin === "workspace" ? vscode.l10n.t("from workspace config") : undefined,
      command: c,
    } as Item);
  }
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  if (!picked) return undefined;
  return picked.last ? "last" : picked.command;
}

async function runCommand(d: CommandDeps, arg: unknown, selection: unknown): Promise<void> {
  let targets: KubeResource[] = [];
  let context: ClusterContext | undefined;
  if (isResourceNode(arg)) {
    targets = resourceTargets(arg, selection);
  } else if (arg !== undefined) {
    const resolved = await fromClusterExplorer(d, arg);
    if (!resolved) return;
    targets = [resolved.resource];
    context = resolved.context;
  }
  if (targets.length === 0) return;
  await pickAndRun(d, targets, context);
}

async function pickAndRun(d: CommandDeps, targets: KubeResource[], context?: ClusterContext): Promise<void> {
  const list = d.commands
    .all()
    .filter((c) => !c.isSnippet && c.isBatch === targets.length > 1 && targets.every((t) => c.matches(t)));
  if (list.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No commands for {0}.", targets[0]!.kind.kind));
    return;
  }
  const title =
    targets.length > 1
      ? vscode.l10n.t("{0} resources", targets.length)
      : `${targets[0]!.kind.kind} ${targets[0]!.name}`;
  const picked = await pickCommand(d, list, title);
  const command = picked === "last" ? d.executor.lastRun?.command : picked;
  if (command) await d.executor.execute(command, targets, context ? { context } : {});
}

/** MS Cluster Explorer nodes belong to kubeconfig's current-context: commands and GET requests use that context. */
async function fromClusterExplorer(
  d: CommandDeps,
  target: unknown,
): Promise<{ resource: KubeResource; context: ClusterContext } | undefined> {
  const explorer = await d.gateway.clusterExplorer();
  const node = explorer.resolveCommandTarget(target);
  if (node?.nodeType !== "resource") return undefined;
  const name = d.contexts.kubeconfigCurrentContext();
  const info = d.contexts.contexts().find((c) => c.name === name);
  if (!name || !info) throw new Error(vscode.l10n.t("kubeconfig has no current-context"));
  const context = new ClusterContext(
    name,
    info.cluster,
    info.user,
    node.namespace ? { type: "single", name: node.namespace } : { type: "all" },
    isProtectedContext(name, d.settings.protectedContexts()),
  );
  const kinds = (await d.source.listKinds(context)).filter((k) => k.kind === node.resourceKind.manifestKind);
  const kind =
    kinds.find((k) => k.plural === node.resourceKind.apiName) ??
    kinds.find((k) => k.group === "" || k.group === "apps") ??
    kinds[0];
  if (!kind) throw new Error(vscode.l10n.t("Unknown kind {0}", node.resourceKind.manifestKind));
  const resource = await d.source.get(context, kind, kind.namespaced ? node.namespace : undefined, node.name);
  return { resource, context };
}

async function runSnippet(d: CommandDeps): Promise<void> {
  const list = d.commands.snippets();
  if (list.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No snippets configured."));
    return;
  }
  const picked = await pickCommand(d, list, vscode.l10n.t("Run snippet on {0}", d.contexts.current?.name ?? ""));
  if (picked === "last") await d.executor.runLast();
  else if (picked) await d.executor.execute(picked, []);
}

/** View/title commands (Open as table, Edit view config) invoked from the sidebar apply to the currently displayed view. */
async function pickView(d: CommandDeps, title: string): Promise<string | undefined> {
  const active = d.trees.activeViewId;
  if (active) return active;
  const picked = await vscode.window.showQuickPick(
    d.views.views().map((v) => ({ label: v.title, description: v.id, viewId: v.id })),
    { title },
  );
  return picked?.viewId;
}

const ORIGIN_LABEL: Record<string, string> = {
  preset: "preset",
  remote: "remote config",
  user: "user config",
  workspace: "workspace config",
};

/** Immediately refetch `k8sView.remoteConfigs` URLs (normally fetched only on activation or setting changes). */
async function reloadRemoteConfigs(d: CommandDeps): Promise<void> {
  if (d.settings.remoteConfigs().length === 0) {
    const open = vscode.l10n.t("Open setting");
    const answer = await vscode.window.showInformationMessage(vscode.l10n.t("No remote config is set."), open);
    if (answer === open) await vscode.commands.executeCommand("workbench.action.openSettings", "k8sView.remoteConfigs");
    return;
  }
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Fetching remote configs…") },
    () => d.loader.refreshRemote(),
  );
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Cannot fetch {0}", failed.map((r) => `${r.url} (${r.error})`).join(", ")),
    );
    return;
  }
  const changed = results.filter((r) => r.changed).length;
  void vscode.window.showInformationMessage(
    changed > 0
      ? vscode.l10n.t("{0} remote config(s) updated.", changed)
      : vscode.l10n.t("Remote configs are up to date."),
  );
}

/** Edit a view's JSON; "Single resource kind" has no file, so offer to create a custom view from that kind. */
async function editView(d: CommandDeps, viewId: string): Promise<void> {
  const view = d.views.get(viewId);
  if (!view) return;
  if (!view.dynamic) return d.writer.editView(view);
  const ctx = d.contexts.current;
  const target = d.kindView.current;
  if (!ctx || !target) return;
  const kind = await d.source.resolveKind(ctx, target);
  if (!kind) throw new Error(vscode.l10n.t("{0} is not served by context {1}", target.kind, ctx.name));
  const id = `${kind.kind.toLowerCase()}-view`;
  if (await d.writer.createView(id, kind.kind, [kind])) await d.trees.setActiveView(id);
}

/** "Single resource kind" view: select any kind served by the cluster (CRDs, rarely used kinds) and display its resources. */
async function selectKind(d: CommandDeps): Promise<void> {
  const ctx = d.contexts.current;
  if (!ctx) throw new Error(vscode.l10n.t("Select a context first"));
  const kinds = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Discovering kinds on {0}…", ctx.name) },
    () => d.source.listKinds(ctx),
  );
  const current = d.kindView.current;
  const items = kinds
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group))
    .map((k) => ({
      label: k.kind,
      description: [
        k.group || "core",
        current?.group === k.group && current.kind === k.kind ? vscode.l10n.t("current") : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      detail: `${k.plural} · ${k.apiVersion}${k.namespaced ? "" : " · cluster-scoped"}`,
      resourceKind: k,
    }));
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Single resource kind: pick a kind"),
    placeHolder: vscode.l10n.t("Type to search, e.g. Certificate, ScaledObject, PersistentVolume"),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const k = picked.resourceKind;
  await d.kindView.select({ group: k.group, kind: k.kind, plural: k.plural });
  await d.trees.setActiveView(d.kindView.viewId);
}

/** CRD → "Single resource kind" view for the kind it defines (discovery chooses the preferred version). */
async function listCrdInstances(d: CommandDeps, arg: unknown): Promise<void> {
  const resolved = await resolveResource(d, arg);
  if (!resolved) return;
  const { resource } = resolved;
  const spec = resource.object["spec"] as { group?: string; names?: { kind?: string; plural?: string } } | undefined;
  if (resource.kind.key !== "apiextensions.k8s.io/CustomResourceDefinition" || !spec?.group || !spec.names?.kind) {
    throw new Error(vscode.l10n.t("List instances works on CustomResourceDefinitions"));
  }
  await d.kindView.select({
    group: spec.group,
    kind: spec.names.kind,
    ...(spec.names.plural ? { plural: spec.names.plural } : {}),
  });
  await d.trees.setActiveView(d.kindView.viewId);
}

/** Show/hide views in "Switch view" (writes `k8sView.views.hidden`); hidden views are never watched. */
async function manageViews(d: CommandDeps): Promise<void> {
  const items = d.views.allViews().map((v) => ({
    label: `$(${v.definition.icon ?? "list-tree"}) ${v.title}`,
    description: [v.id, ORIGIN_LABEL[v.origin]].filter(Boolean).join(" · "),
    picked: !d.views.isHidden(v.id),
    viewId: v.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("K8s View: Show/hide views"),
    placeHolder: vscode.l10n.t("Checked views are listed in Switch view; unchecked ones are hidden"),
    canPickMany: true,
  });
  if (!picked) return;
  const visible = new Set(picked.map((p) => p.viewId));
  // Retain hidden IDs for views not currently loaded (e.g. disabled presets).
  const unknown = d.settings.hiddenViews().filter((id) => !d.views.get(id));
  await d.settings.setHiddenViews([...unknown, ...items.filter((i) => !visible.has(i.viewId)).map((i) => i.viewId)]);
}

const FAVORITE_SLOTS = 9;

/** Slots 1–9 for table hotkeys `1`–`9` (`k8sView.views.favorites`): choose a slot, then a view; repeat until Esc. */
async function configureFavoriteViews(d: CommandDeps): Promise<void> {
  const viewLabel = (id: string) => {
    const view = d.views.get(id);
    return view ? `$(${view.definition.icon ?? "list-tree"}) ${view.title}` : id;
  };
  for (;;) {
    const favorites = Array.from({ length: FAVORITE_SLOTS }, (_, i) => d.settings.favoriteViews()[i] ?? "");
    const slot = await vscode.window.showQuickPick(
      favorites.map((id, i) => ({
        label: `${i + 1}`,
        description: id ? viewLabel(id) : vscode.l10n.t("(empty)"),
        ...(id && !d.views.get(id) ? { detail: vscode.l10n.t("View '{0}' is not loaded", id) } : {}),
        slot: i,
      })),
      {
        title: vscode.l10n.t("K8s View: Favorite views (table hotkeys 1–9)"),
        placeHolder: vscode.l10n.t("Pick a slot to change; Esc when done"),
        matchOnDescription: true,
      },
    );
    if (!slot) return;
    type Item = vscode.QuickPickItem & { viewId?: string };
    const items: Item[] = [
      ...(favorites[slot.slot] ? [{ label: `$(close) ${vscode.l10n.t("Clear slot")}`, viewId: "" }] : []),
      ...d.views.allViews().map((v) => ({
        label: `$(${v.definition.icon ?? "list-tree"}) ${v.title}`,
        description: [
          v.id === favorites[slot.slot] ? vscode.l10n.t("current") : undefined,
          v.id,
          ORIGIN_LABEL[v.origin],
          d.views.isHidden(v.id) ? vscode.l10n.t("hidden") : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        viewId: v.id,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("K8s View: Favorite view {0}", slot.slot + 1),
      matchOnDescription: true,
    });
    if (picked?.viewId === undefined) continue;
    favorites[slot.slot] = picked.viewId;
    await d.settings.setFavoriteViews(favorites);
  }
}

/** Switch the sidebar view; includes shortcuts to create custom views, edit JSON, hide views, and open "Single resource kind". */
async function switchView(d: CommandDeps): Promise<void> {
  type Item = vscode.QuickPickItem & {
    viewId?: string;
    action?: "create" | "edit" | "kind" | "manage" | "favorites";
  };
  const active = d.trees.activeViewId;
  const editButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("edit"),
    tooltip: vscode.l10n.t("Edit view config"),
  };
  const tableButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("table"),
    tooltip: vscode.l10n.t("Open as table"),
  };
  const hideButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("eye-closed"),
    tooltip: vscode.l10n.t("Hide this view (k8sView.views.hidden)"),
  };
  const views: Item[] = d.sessions.all().map((s) => ({
    label: `$(${s.definition.icon ?? "list-tree"}) ${s.definition.title}`,
    description: [
      s.definition.id === active ? vscode.l10n.t("current") : undefined,
      ORIGIN_LABEL[s.view.origin],
      s.available ? undefined : vscode.l10n.t("not served by this cluster"),
    ]
      .filter(Boolean)
      .join(" · "),
    viewId: s.definition.id,
    buttons: [tableButton, editButton, hideButton],
  }));
  const activeTitle = active ? d.views.get(active)?.title : undefined;
  const kindViewShown = views.some((v) => v.viewId === d.kindView.viewId);
  const items: Item[] = [
    ...views,
    ...(d.views.isHidden(d.kindView.viewId)
      ? []
      : [
          {
            label: `$(search) ${kindViewShown ? vscode.l10n.t("Change resource kind…") : vscode.l10n.t("Single resource kind…")}`,
            detail: vscode.l10n.t("List the resources of any kind served by the cluster (CRDs, rarely used kinds)"),
            action: "kind" as const,
          },
        ]),
    { label: vscode.l10n.t("Configure"), kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(new-file) ${vscode.l10n.t("Create custom view…")}`,
      detail: vscode.l10n.t("Pick resource kinds, then design the view in a JSON file"),
      action: "create",
    },
    {
      label: `$(eye) ${vscode.l10n.t("Show/hide views…")}`,
      detail: vscode.l10n.t("Hide the views you do not use (setting k8sView.views.hidden)"),
      action: "manage",
    },
    {
      label: `$(star) ${vscode.l10n.t("Configure favorite views…")}`,
      detail: vscode.l10n.t("Views switched to by hotkeys 1–9 in the table (setting k8sView.views.favorites)"),
      action: "favorites",
    },
    ...(active && activeTitle
      ? [
          {
            label: `$(edit) ${vscode.l10n.t("Edit '{0}' view config…", activeTitle)}`,
            viewId: active,
            action: "edit" as const,
          },
        ]
      : []),
  ];

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = vscode.l10n.t("K8s View: Switch view");
  qp.placeholder = vscode.l10n.t("Only the selected view is shown and watched");
  qp.matchOnDescription = true;
  qp.items = items;
  const current = views.find((i) => i.viewId === active);
  if (current) qp.activeItems = [current];
  const choice = await new Promise<{ item: Item; button?: vscode.QuickInputButton } | undefined>((resolve) => {
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      resolve(item ? { item } : undefined);
    });
    qp.onDidTriggerItemButton((e) => resolve({ item: e.item, button: e.button }));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!choice) return;
  const { item, button } = choice;
  if (item.action === "create") return createCustomView(d);
  if (item.action === "kind") return selectKind(d);
  if (item.action === "manage") return manageViews(d);
  if (item.action === "favorites") return configureFavoriteViews(d);
  const view = item.viewId ? d.views.get(item.viewId) : undefined;
  if (!view) return;
  if (item.action === "edit" || button === editButton) return editView(d, view.id);
  if (button === tableButton) return d.tables.open(view.id);
  if (button === hideButton) return d.settings.setHiddenViews([...d.settings.hiddenViews(), view.id]);
  await d.trees.setActiveView(view.id);
}

async function createCustomView(d: CommandDeps): Promise<void> {
  const ctx = d.contexts.current;
  if (!ctx) throw new Error(vscode.l10n.t("Select a context first"));
  const kinds = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Discovering kinds on {0}…", ctx.name) },
    () => d.source.listKinds(ctx),
  );
  const picked = await vscode.window.showQuickPick(
    kinds
      .sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind))
      .map((k) => ({
        label: k.kind,
        description: k.group || "core",
        detail: `${k.apiVersion} · ${k.plural}${k.namespaced ? "" : " · cluster-scoped"}`,
        resourceKind: k,
      })),
    { title: vscode.l10n.t("Create custom view: pick kinds"), canPickMany: true, matchOnDescription: true },
  );
  if (!picked || picked.length === 0) return;
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t("View title"),
    value: picked[0]!.resourceKind.kind,
  });
  if (!title) return;
  const id =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom-view";
  const created = await d.writer.createView(
    id,
    title,
    picked.map((p) => p.resourceKind),
  );
  // The new view appears in the sidebar as soon as the file is loaded.
  if (created) await d.trees.setActiveView(id);
}
