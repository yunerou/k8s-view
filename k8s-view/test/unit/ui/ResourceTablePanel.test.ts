import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { CommandExecutor } from "../../../src/app/CommandExecutor";
import { CommandRegistry } from "../../../src/app/CommandRegistry";
import { ContextService } from "../../../src/app/ContextService";
import { HotkeyService } from "../../../src/app/HotkeyService";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import { ViewSessionManager } from "../../../src/app/ViewSessionManager";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import type { CommandItem, RelatedGroup, RowDetails } from "../../../src/shared/protocol";
import type { ConfigWriter } from "../../../src/ui/ConfigWriter";
import type { ManifestDocumentProvider } from "../../../src/ui/ManifestDocumentProvider";
import { ResourceTablePanels } from "../../../src/ui/webview/ResourceTablePanel";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

const { handlers, notifications, pick } = vi.hoisted(() => ({
  handlers: new Map<string, (params?: unknown) => unknown>(),
  notifications: [] as string[],
  pick: vi.fn(),
}));
let panel: vscode.WebviewPanel;
vi.mock("vscode", async (original) => ({
  ...(await original<typeof import("vscode")>()),
  ViewColumn: { Active: -1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  window: { createWebviewPanel: () => panel, showQuickPick: pick },
}));
vi.mock("vscode-messenger", () => ({
  Messenger: class {
    registerWebviewPanel() {
      return {};
    }
    onRequest(type: { method: string }, handler: (params?: unknown) => unknown) {
      handlers.set(type.method, handler);
      return { dispose() {} };
    }
    sendNotification(type: { method: string }) {
      notifications.push(type.method);
    }
  },
}));

let tables: ResourceTablePanels;
let sessions: ViewSessionManager;
let contexts: ContextService;
let source: FakeResourceSource;
const execute = vi.fn(async () => "ok" as const);
const deployment = res(kinds.deployment, "web", {}, "a");
const second = res(kinds.deployment, "api", {}, "a");
const selection = { sectionId: "deployments", uids: [deployment.uid, second.uid] };
const rootKey = `table:details:${deployment.uid}`;

async function request<T>(method: string, params?: unknown): Promise<T> {
  return (await handlers.get(`table/${method}`)!(params)) as T;
}

beforeEach(async () => {
  handlers.clear();
  notifications.length = 0;
  execute.mockClear();
  pick.mockReset();
  const state = new FakeState();
  const settings = new FakeSettings();
  contexts = new ContextService(
    new FakeKubeConfig([{ name: "dev", cluster: "dev", user: "u", namespace: "a" }], "dev"),
    state,
    settings,
    new FakeClusterApi(),
  );
  await contexts.initialize();
  source = new FakeResourceSource();
  source.addKind(kinds.deployment, kinds.pod);
  source.set({ group: "apps", kind: "Deployment" }, "a", [deployment, second]);
  const registry = new ViewRegistry();
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
  panel = {
    visible: true,
    active: true,
    title: "Table",
    reveal() {},
    dispose() {},
    webview: { html: "", cspSource: "test", asWebviewUri: (uri: vscode.Uri) => uri },
    onDidChangeViewState: new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>().event,
    onDidDispose: new vscode.EventEmitter<void>().event,
  } as unknown as vscode.WebviewPanel;
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
    {} as ManifestDocumentProvider,
    new HotkeyService(state, settings, registry),
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
});
