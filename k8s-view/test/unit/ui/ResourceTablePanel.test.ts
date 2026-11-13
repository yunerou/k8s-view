import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { CommandExecutor } from "../../../src/app/CommandExecutor";
import { CommandRegistry } from "../../../src/app/CommandRegistry";
import { ContextService } from "../../../src/app/ContextService";
import { HotkeyService } from "../../../src/app/HotkeyService";
import { ScopedViewService } from "../../../src/app/ScopedViewService";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import { ViewSessionManager } from "../../../src/app/ViewSessionManager";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import type { CommandItem, RelatedGroup, RowDetails, TableViewModel } from "../../../src/shared/protocol";
import type { ConfigWriter } from "../../../src/ui/ConfigWriter";
import type { ManifestDocumentProvider } from "../../../src/ui/ManifestDocumentProvider";
import { ResourceTablePanels } from "../../../src/ui/webview/ResourceTablePanel";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

type Handler = (params?: unknown) => unknown;
const { handlers, byPanel, notifications, sent, pick, openExternal, info } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  /** Request handlers of each table tab (keyed by its webview panel). */
  byPanel: new Map<unknown, Map<string, Handler>>(),
  notifications: [] as string[],
  sent: [] as { method: string; panel: unknown }[],
  pick: vi.fn(),
  openExternal: vi.fn(async () => true),
  info: vi.fn(),
}));
let panel: vscode.WebviewPanel;
vi.mock("vscode", async (original) => ({
  ...(await original<typeof import("vscode")>()),
  env: { openExternal },
  ViewColumn: { Active: -1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  window: { createWebviewPanel: () => panel, showQuickPick: pick, showInformationMessage: info },
}));
vi.mock("vscode-messenger", () => ({
  Messenger: class {
    private panel: unknown;
    registerWebviewPanel(p: unknown) {
      this.panel = p;
      return { panel: p };
    }
    onRequest(type: { method: string }, handler: Handler) {
      handlers.set(type.method, handler);
      const own = byPanel.get(this.panel) ?? new Map<string, Handler>();
      own.set(type.method, handler);
      byPanel.set(this.panel, own);
      return { dispose() {} };
    }
    sendNotification(type: { method: string }, participant?: { panel: unknown }) {
      notifications.push(type.method);
      sent.push({ method: type.method, panel: participant?.panel });
    }
  },
}));

let tables: ResourceTablePanels;
let sessions: ViewSessionManager;
let contexts: ContextService;
let source: FakeResourceSource;
let registry: ViewRegistry;
let state: FakeState;
let scoped: ScopedViewService;
let manifestsOpen: ReturnType<typeof vi.fn>;
const execute = vi.fn(async () => "ok" as const);
const deployment = res(kinds.deployment, "web", {}, "a");
const second = res(kinds.deployment, "api", {}, "a");
const selection = { sectionId: "deployments", uids: [deployment.uid, second.uid] };
const rootKey = `table:details:${deployment.uid}`;

async function request<T>(method: string, params?: unknown): Promise<T> {
  return (await handlers.get(`table/${method}`)!(params)) as T;
}

function makePanel(): vscode.WebviewPanel {
  return {
    visible: true,
    active: true,
    title: "Table",
    reveal() {},
    dispose: vi.fn(),
    webview: { html: "", cspSource: "test", asWebviewUri: (uri: vscode.Uri) => uri },
    onDidChangeViewState: new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>().event,
    onDidDispose: new vscode.EventEmitter<void>().event,
  } as unknown as vscode.WebviewPanel;
}

beforeEach(async () => {
  handlers.clear();
  byPanel.clear();
  notifications.length = 0;
  sent.length = 0;
  execute.mockClear();
  pick.mockReset();
  openExternal.mockClear();
  state = new FakeState();
  const settings = new FakeSettings();
  contexts = new ContextService(
    new FakeKubeConfig(
      [
        { name: "dev", cluster: "dev", user: "u", namespace: "a" },
        { name: "prod", cluster: "prod", user: "u", namespace: "a" },
      ],
      "dev",
    ),
    state,
    settings,
    new FakeClusterApi(),
  );
  await contexts.initialize();
  source = new FakeResourceSource();
  source.addKind(kinds.deployment, kinds.pod);
  source.set({ group: "apps", kind: "Deployment" }, "a", [deployment, second]);
  registry = new ViewRegistry();
  const commands = new CommandRegistry();
  const config = parseConfigText(
    JSON.stringify({
      version: 1,
      views: [
        {
          id: "workload",
          title: "Workload",
          sections: [
            {
              id: "deployments",
              title: "Deployments",
              resources: [{ group: "apps", kind: "Deployment" }],
              children: [
                {
                  id: "pods",
                  relation: { type: "ownerRef", kind: "Pod" },
                  children: [
                    {
                      id: "containers",
                      relation: {
                        type: "field",
                        items: "$.spec.containers[*]",
                        label: "${$.name}",
                        description: "${$.image}",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        { id: "pods", title: "Pods", sections: [{ id: "pods", title: "Pods", resources: [{ kind: "Pod" }] }] },
        {
          id: "multi",
          title: "Multi",
          sections: [
            { id: "deployments", title: "Deployments", resources: [{ group: "apps", kind: "Deployment" }] },
            { id: "pods", title: "Pods", resources: [{ kind: "Pod" }] },
          ],
        },
      ],
      commands: [
        {
          id: "manifest",
          title: "Manifest",
          match: [{ group: "*", kind: "*" }],
          run: { type: "vscode", command: "k8sView.openManifest" },
        },
        {
          id: "copy",
          title: "Copy names",
          match: [{ group: "*", kind: "*" }],
          run: { type: "batch", operation: "copyNames" },
        },
        {
          id: "scale",
          title: "Scale",
          dangerous: true,
          match: [{ group: "apps", kind: "Deployment" }],
          run: { type: "batch", operation: "scale", replicas: "2" },
        },
      ],
    }),
  );
  const files = [{ id: "test", origin: "builtin" as const, parsed: config }];
  const ctx = { trusted: true, isPresetActive: () => true };
  registry.apply(files, ctx, new Map());
  commands.apply(files, ctx, new Map());
  sessions = new ViewSessionManager(registry, contexts, source, settings);
  await sessions.session("workload")!.whenReady();
  panel = makePanel();
  scoped = new ScopedViewService(registry, contexts, source);
  manifestsOpen = vi.fn(async () => undefined);
  tables = new ResourceTablePanels(
    { extensionUri: vscode.Uri.file("/extension") } as vscode.ExtensionContext,
    sessions,
    contexts,
    commands,
    { execute } as unknown as CommandExecutor,
    settings,
    source,
    state,
    {} as ConfigWriter,
    { open: manifestsOpen } as unknown as ManifestDocumentProvider,
    new HotkeyService(state, settings, registry),
    scoped,
    new FakeClusterApi(),
  );
  tables.open("workload");
  await request("getViewModel");
});
afterEach(() => {
  tables.dispose();
  sessions.dispose();
});

describe("table commands and related tree", () => {
  test("multiple selections expose only batch commands and reject single-resource execution", async () => {
    expect((await request<CommandItem[]>("commandsFor", selection)).map((c) => c.id)).toEqual(["copy", "scale"]);
    expect(
      (await request<CommandItem[]>("commandsFor", { ...selection, uids: [deployment.uid] })).map((c) => c.id),
    ).toEqual(["manifest"]);
    expect(await request("runCommand", { ...selection, commandId: "manifest" })).toBe("blocked");
    expect(await request("commandsFor", { ...selection, uids: [deployment.uid, "missing"] })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  test("opens the selected resource's curated guide and ignores missing resources", async () => {
    const ref = { sectionId: "deployments", uid: deployment.uid };
    const details = await request<RowDetails>("details", ref);
    expect(details.documentation).toEqual({
      kind: "Deployment",
      url: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
    });
    await request("openDocumentation", { ...ref, url: "https://untrusted.example/" });
    expect(openExternal).toHaveBeenCalledWith(vscode.Uri.parse(details.documentation!.url));
    await request("openDocumentation", { ...ref, uid: "missing" });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  test("related children expand recursively and closing the root releases their watches", async () => {
    const pod = res(
      kinds.pod,
      "web-1",
      {
        metadata: {
          name: "web-1",
          uid: "pod1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: deployment.name, uid: deployment.uid }],
        },
        spec: { containers: [{ name: "app", image: "nginx" }] },
      },
      "a",
    );
    source.set({ group: "", kind: "Pod" }, "a", [pod]);
    const details = await request<RowDetails>("details", { sectionId: "deployments", uid: deployment.uid });
    const item = details.related[0]!.items[0]!;
    expect(item).toMatchObject({ kind: "Pod", name: "web-1", expandable: true });
    expect(source.active()).toContain("/Pod|a");
    const children = await request<RelatedGroup[]>("related", { key: item.key });
    expect(children[0]!.items[0]).toMatchObject({ kind: "field", name: "app", description: "nginx" });
    await request("closeRelated", { key: rootKey, dispose: true });
    expect(source.active()).toEqual(["apps/Deployment|a"]);
    expect(await request("related", { key: item.key })).toEqual([]);
  });

  test("the native picker preserves batch filtering and does not execute blocked commands", async () => {
    pick.mockImplementation(async (items: (vscode.QuickPickItem & { action?: string })[]) =>
      items.find((i) => i.action === "command:scale"),
    );
    await request("pickCommand", selection);
    const items = pick.mock.calls[0]![0] as (vscode.QuickPickItem & { action?: string })[];
    expect(items.filter((i) => i.action).map((i) => i.action)).toEqual(["command:copy", "command:scale"]);
    expect(execute).not.toHaveBeenCalled();
  });

  test("a late close request cannot dispose a different resource's drawer", async () => {
    await request("details", { sectionId: "deployments", uid: deployment.uid });
    await request("details", { sectionId: "deployments", uid: second.uid });
    await request("closeRelated", { key: rootKey, dispose: true });
    expect(await request<RelatedGroup[]>("related", { key: `table:details:${second.uid}` })).toHaveLength(1);
  });

  test("details list parents grouped by kind and expand to grandparents", async () => {
    source.addKind(kinds.replicaSet);
    const rs = res(
      kinds.replicaSet,
      "web-1",
      {
        metadata: {
          name: "web-1",
          uid: "rs-web-1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: deployment.uid }],
        },
      },
      "a",
    );
    const pod = res(
      kinds.pod,
      "web-1-x",
      {
        metadata: {
          name: "web-1-x",
          uid: "pod-web-1-x",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-1", uid: rs.uid }],
        },
      },
      "a",
    );
    source.set({ group: "apps", kind: "ReplicaSet" }, "a", [rs]);
    source.set({ group: "", kind: "Pod" }, "a", [pod]);
    await sessions.session("pods")!.whenReady();
    tables.open("pods");
    await request("getViewModel");
    const details = await request<RowDetails>("details", { sectionId: "pods", uid: pod.uid });
    expect(details.parents).toEqual([
      {
        key: `table:parents:${pod.uid}/ReplicaSet`,
        title: "ReplicaSet",
        items: [
          expect.objectContaining({
            key: `table:parents:${pod.uid}/${rs.uid}`,
            kind: "ReplicaSet",
            name: "web-1",
            namespace: "a",
            description: "owner",
            expandable: true,
          }),
        ],
      },
    ]);
    const up = await request<RelatedGroup[]>("parents", { key: `table:parents:${pod.uid}/${rs.uid}` });
    expect(up.map((g) => [g.title, g.items.map((i) => i.name)])).toEqual([["Deployment", ["web"]]]);
  });
});

describe("section tabs", () => {
  async function openMulti(activeSection?: string) {
    await sessions.session("multi")!.whenReady();
    panel = makePanel();
    source.acquired = [];
    tables.open("multi");
    return request<TableViewModel>("getViewModel", activeSection ? { activeSection } : {});
  }

  test("only the active tab watches its kinds; other tabs show the store's data", async () => {
    const vm = await openMulti();
    expect(source.acquired).toEqual(["apps/Deployment|a"]);
    expect(vm.sections.map((s) => [s.id, s.state])).toEqual([
      ["deployments", "ready"],
      ["pods", "loading"],
    ]);
    await request("setActiveSection", { sectionId: "pods" });
    expect(source.active()).toContain("/Pod|a");
    // The workload tab still holds its Deployment lease; this tab released its own.
    expect(source.leases.get("apps/Deployment|a")).toBe(1);
    await request("setActiveSection", { sectionId: "deployments" });
    expect(source.active()).not.toContain("/Pod|a");
  });

  test("the restored tab is the one watched from the first model", async () => {
    const vm = await openMulti("pods");
    expect(source.acquired).toEqual(["/Pod|a"]);
    // Deployments are already in the shared store (workload tab): shown without a lease.
    expect(vm.sections.find((s) => s.id === "deployments")!.rows.map((r) => r.name)).toEqual(["api", "web"]);
  });
});

describe("scoped tabs", () => {
  const ownedPod = () =>
    res(
      kinds.pod,
      "web-x",
      {
        metadata: {
          name: "web-x",
          uid: "pod-web-x",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: deployment.uid }],
        },
      },
      "a",
    );

  async function openRelated() {
    const pod = ownedPod();
    source.set({ group: "", kind: "Pod" }, "a", [pod, res(kinds.pod, "api-x", {}, "a")]);
    expect(await request("openScoped", { sectionId: "deployments", uid: deployment.uid, direction: "related" })).toBe(
      true,
    );
    await sessions.session(`related.${deployment.uid}`)!.whenReady();
    return { pod, vm: await request<TableViewModel>("getViewModel") };
  }

  test("Open Related opens a tab limited to the source's pods", async () => {
    const { vm } = await openRelated();
    expect(vm.viewId).toBe(`related.${deployment.uid}`);
    expect(vm.title).toBe("Related · Deployment a/web");
    expect(vm.sections.map((s) => [s.id, s.rows.map((r) => r.name)])).toEqual([["pod", ["web-x"]]]);
    expect(vm.scope).toEqual({
      direction: "related",
      context: "dev",
      source: { group: "apps", kind: "Deployment", namespace: "a", name: "web", uid: deployment.uid },
      enabled: true,
      sourceMissing: false,
    });
  });

  test("reveals the existing tab instead of registering it again", async () => {
    await openRelated();
    const view = sessions.session(`related.${deployment.uid}`)!.view;
    expect(
      tables.openScoped("related", {
        group: "apps",
        kind: "Deployment",
        namespace: "a",
        name: "web",
        uid: deployment.uid,
      }),
    ).toBe(true);
    expect(sessions.session(`related.${deployment.uid}`)!.view).toBe(view);
  });

  test("turning the scope off shows every pod; the source opens as a manifest", async () => {
    await openRelated();
    await request("setScopeEnabled", { enabled: false });
    const vm = await request<TableViewModel>("getViewModel");
    expect(vm.sections[0]!.rows.map((r) => r.name).sort()).toEqual(["api-x", "web-x"]);
    expect(vm.scope?.enabled).toBe(false);
    await request("openScopeSource");
    expect(manifestsOpen).toHaveBeenCalledWith({
      context: "dev",
      group: "apps",
      kind: "Deployment",
      namespace: "a",
      name: "web",
    });
  });

  test("scoped tabs share preferences per direction", async () => {
    await openRelated();
    await request("savePrefs", { sectionId: "pod", prefs: { filter: "x" } });
    expect(state.getWorkspace("k8sView.tablePrefs/scoped:related")).toEqual({ pod: { filter: "x" } });
  });

  test("kinds without relations show a message instead of a tab", async () => {
    expect(tables.openScoped("related", { group: "", kind: "ConfigMap", namespace: "a", name: "cm", uid: "cm1" })).toBe(
      false,
    );
    expect(info).toHaveBeenCalled();
  });

  test("context change closes scoped tabs", async () => {
    await openRelated();
    scoped.clear();
    expect(panel.dispose).toHaveBeenCalled();
  });

  test("namespace change keeps scoped tabs", async () => {
    await openRelated();
    await contexts.selectNamespace({ type: "single", name: "b" });
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(sessions.session(`related.${deployment.uid}`)).toBeDefined();
  });

  test("opening and closing a scoped tab leaves other tables and their open drawers alone", async () => {
    const workloadPanel = panel;
    const workload = byPanel.get(workloadPanel)!;
    source.set({ group: "", kind: "Pod" }, "a", [ownedPod()]);
    await workload.get("table/details")!({ sectionId: "deployments", uid: deployment.uid });
    panel = makePanel();
    sent.length = 0;
    expect(
      await workload.get("table/openScoped")!({ sectionId: "deployments", uid: deployment.uid, direction: "related" }),
    ).toBe(true);
    expect(byPanel.has(panel)).toBe(true);
    scoped.remove(`related.${deployment.uid}`);
    expect(sent.filter((n) => n.panel === workloadPanel && n.method === "table/reset")).toEqual([]);
    expect(workloadPanel.dispose).not.toHaveBeenCalled();
    expect(((await workload.get("table/related")!({ key: rootKey })) as RelatedGroup[])[0]!.items).toHaveLength(1);
  });

  test("restores a scoped tab from webview state only in its context", async () => {
    const pod = ownedPod();
    source.set({ group: "", kind: "Pod" }, "a", [pod]);
    const scopeRef = {
      direction: "related" as const,
      context: "dev",
      source: { group: "apps", kind: "Deployment", namespace: "a", name: "web", uid: deployment.uid },
    };
    await tables.deserializeWebviewPanel(panel, { viewId: `related.${deployment.uid}`, scope: scopeRef });
    expect(sessions.session(`related.${deployment.uid}`)).toBeDefined();
    const other = { ...panel, dispose: vi.fn() } as unknown as vscode.WebviewPanel;
    await tables.deserializeWebviewPanel(other, { viewId: "related.x", scope: { ...scopeRef, context: "prod" } });
    expect(other.dispose).toHaveBeenCalled();
  });
});

describe("independent table context", () => {
  test("pins the tab until disabled without persisting namespace changes", async () => {
    const shared = contexts.current;
    const writeGlobal = vi.spyOn(state, "setGlobal");
    await request("setIndependent", { enabled: true });
    await contexts.selectContext("prod");
    let model = await request<TableViewModel>("getViewModel");
    expect(model.context).toBe("dev");
    expect(model.independent).toBe(true);
    await request("hotkey", { action: { namespace: "private" }, sectionId: "deployments", uids: [] });
    model = await request<TableViewModel>("getViewModel");
    expect(model.namespaceScope).toEqual({ type: "single", name: "private" });
    expect(contexts.current?.name).toBe("prod");
    expect(contexts.current?.scope).toEqual(shared?.scope);
    expect(writeGlobal).not.toHaveBeenCalled();
    await request("setIndependent", { enabled: false });
    model = await request<TableViewModel>("getViewModel");
    expect(model.context).toBe("prod");
    expect(model.independent).toBe(false);
  });

  test("cluster picker changes only the tab and commands use its context", async () => {
    await request("setIndependent", { enabled: true });
    pick.mockImplementationOnce((items) => items.find((item: { label: string }) => item.label === "prod"));
    await request("pickContext");
    await vi.waitFor(async () => {
      const model = await request<TableViewModel>("getViewModel");
      expect(model.sections[0]?.rows.length).toBeGreaterThan(0);
    });
    expect((await request<TableViewModel>("getViewModel")).context).toBe("prod");
    expect(contexts.current?.name).toBe("dev");
    const commands = await request<CommandItem[]>("commandsFor", { sectionId: "deployments", uids: [deployment.uid] });
    await request("runCommand", {
      sectionId: "deployments",
      uids: [deployment.uid],
      commandId: commands.find((c) => !c.blocked)!.id,
    });
    expect((execute.mock.calls as unknown[][])[0]?.[2]).toMatchObject({ context: { name: "prod" } });
    await request("openManifest", { sectionId: "deployments", uid: deployment.uid });
    expect(manifestsOpen).toHaveBeenLastCalledWith(expect.objectContaining({ context: "prod" }));
  });

  test("keeps pinned related tabs across shared cluster changes", async () => {
    await request("setIndependent", { enabled: true });
    const origin = panel;
    panel = makePanel();
    await request("openScoped", { sectionId: "deployments", uid: deployment.uid, direction: "related" });
    const relatedHandlers = byPanel.get(panel)!;
    expect(((await relatedHandlers.get("table/getViewModel")!()) as TableViewModel).context).toBe("dev");
    await contexts.selectContext("prod");
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(((await relatedHandlers.get("table/getViewModel")!()) as TableViewModel).context).toBe("dev");
    expect(byPanel.has(origin)).toBe(true);
  });
});

test("Pod details include complete container configuration", async () => {
  const containers = [
    {
      name: "app",
      image: "nginx:1.27",
      command: ["nginx"],
      args: ["-g", "daemon off;"],
      resources: { requests: { cpu: "100m" }, limits: { memory: "256Mi" } },
    },
  ];
  const pod = res(kinds.pod, "app", { spec: { containers } }, "a");
  source.set(kinds.pod, "a", [pod]);
  panel = makePanel();
  tables.open("pods");
  await request("getViewModel");
  const details = await request<RowDetails>("details", { sectionId: "pods", uid: pod.uid });
  expect(details.containers).toEqual(containers);
});

test("closing an independent tab disposes its session and does not change shared context", async () => {
  const disposed = new vscode.EventEmitter<void>();
  panel = makePanel();
  Object.defineProperty(panel, "onDidDispose", { value: disposed.event });
  tables.open("pods");
  const create = vi.spyOn(sessions, "createIndependent");
  await request("setIndependent", { enabled: true });
  const local = create.mock.results[0]!.value!;
  const dispose = vi.spyOn(local, "dispose");
  const shared = contexts.current;
  disposed.fire();
  expect(dispose).toHaveBeenCalledOnce();
  expect(contexts.current).toBe(shared);
});

describe("multiple tabs of the same view", () => {
  async function model(tab: vscode.WebviewPanel) {
    return (await byPanel.get(tab)!.get("table/getViewModel")!()) as TableViewModel;
  }

  test("opens a separate pinned tab and commands use only its selected context", async () => {
    const original = panel;
    panel = makePanel();
    tables.openNew("workload");
    const duplicate = panel;
    expect(byPanel.has(duplicate)).toBe(true);
    expect(await model(duplicate)).toMatchObject({ viewId: "workload", context: "dev", independent: true });
    pick.mockImplementationOnce((items) => items.find((item: { label: string }) => item.label === "prod"));
    await request("pickContext");
    expect(await model(duplicate)).toMatchObject({ context: "prod", independent: true });
    expect(await model(original)).toMatchObject({ context: "dev", independent: false });
    await request("runCommand", { sectionId: "deployments", uids: [deployment.uid], commandId: "manifest" });
    expect(execute).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ context: expect.objectContaining({ name: "prod" }) }),
    );
  });

  test("tabs following the shared context hold separate leases and survive another tab closing", async () => {
    const original = panel;
    const disposed = new vscode.EventEmitter<void>();
    panel = makePanel();
    Object.defineProperty(panel, "onDidDispose", { value: disposed.event });
    tables.openNew("workload");
    await request("setIndependent", { enabled: false });
    await model(panel);
    expect(source.leases.get("apps/Deployment|a")).toBe(2);
    disposed.fire();
    expect(source.leases.get("apps/Deployment|a")).toBe(1);
    expect((await model(original)).sections[0]!.rows).toHaveLength(2);
    const reveal = vi.spyOn(original, "reveal");
    tables.open("workload");
    expect(reveal).toHaveBeenCalledOnce();
    disposed.dispose();
  });

  test("duplicates the active tab’s private cluster and namespace", async () => {
    await request("setIndependent", { enabled: true });
    await request("hotkey", { action: { namespace: "private" }, sectionId: "deployments", uids: [] });
    panel = makePanel();
    tables.openNew();
    expect(await model(panel)).toMatchObject({
      context: "dev",
      namespaceScope: { type: "single", name: "private" },
      independent: true,
    });
    await request("setIndependent", { enabled: false });
    await contexts.selectContext("prod");
    expect(await model(panel)).toMatchObject({ context: "prod", independent: false });
  });

  test("restores two instances without losing either panel", async () => {
    const original = panel;
    const restored = makePanel();
    await tables.deserializeWebviewPanel(restored, { viewId: "workload" });
    expect(await model(original)).toMatchObject({ viewId: "workload" });
    expect(await model(restored)).toMatchObject({ viewId: "workload" });
    expect(source.leases.get("apps/Deployment|a")).toBe(2);
    tables.dispose();
    expect(original.dispose).toHaveBeenCalled();
    expect(restored.dispose).toHaveBeenCalled();
  });
});
