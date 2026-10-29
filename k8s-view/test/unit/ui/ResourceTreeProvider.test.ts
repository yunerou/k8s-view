import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter, TreeItemCollapsibleState } from "vscode";
import { ContextService } from "../../../src/app/ContextService";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import { ViewSessionManager } from "../../../src/app/ViewSessionManager";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import type { PortForwardInfo } from "../../../src/ui/portForward";
import { ResourceTreeProvider } from "../../../src/ui/tree/ResourceTreeProvider";
import type { TreeNode } from "../../../src/ui/tree/TreeNode";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

const config = {
  version: 1,
  views: [
    {
      id: "workload",
      title: "Workload",
      sections: [
        {
          id: "deployments",
          title: "Deployments",
          icon: "rocket",
          resources: [{ group: "apps", kind: "Deployment" }],
          status: { preset: "replicas" },
          children: [
            {
              id: "pods",
              relation: { type: "ownerRef", kind: "Pod" },
              children: [{ id: "c", relation: { type: "field", items: "$.spec.containers[*]", label: "${$.name}" } }],
            },
          ],
        },
        {
          id: "sas",
          title: "SAs",
          resources: [{ kind: "ServiceAccount" }],
          children: [
            {
              id: "rb",
              title: "RoleBindings",
              relation: {
                type: "reverseFieldRef",
                group: "rbac.authorization.k8s.io",
                kind: "RoleBinding",
                items: "$.subjects[*]",
                match: { name: "${name}" },
              },
            },
          ],
        },
      ],
    },
  ],
};

let source: FakeResourceSource;
let provider: ResourceTreeProvider;

const labels = (nodes: TreeNode[]) => nodes.map((n) => provider.getTreeItem(n).label);

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  const settings = new FakeSettings();
  const contexts = new ContextService(
    new FakeKubeConfig([{ name: "dev", cluster: "dev", user: "u", namespace: "a" }], "dev"),
    new FakeState(),
    settings,
    new FakeClusterApi(),
  );
  await contexts.initialize();
  source = new FakeResourceSource();
  source.addKind(kinds.deployment, kinds.pod, kinds.serviceAccount, kinds.roleBinding);
  const registry = new ViewRegistry();
  registry.apply(
    [{ id: "f", origin: "builtin", parsed: parseConfigText(JSON.stringify(config)) }],
    { trusted: true, isPresetActive: () => true },
    new Map(),
  );
  const manager = new ViewSessionManager(registry, contexts, source, settings);
  await manager.session("workload")!.whenReady();
  provider = new ResourceTreeProvider(manager, "workload");
});

describe("ResourceTreeProvider", () => {
  test("roots are the available sections", () => {
    expect(labels(provider.getChildren())).toEqual(["Deployments", "SAs"]);
  });

  test("section shows loading then resources with status icon, description and context value", () => {
    const [deployments] = provider.getChildren();
    expect(labels(provider.getChildren(deployments))).toEqual(["Loading…"]);
    const d = res(kinds.deployment, "web", { spec: { replicas: 2 }, status: { readyReplicas: 1 } }, "a");
    source.set({ group: "apps", kind: "Deployment" }, "a", [d]);
    const [node] = provider.getChildren(deployments);
    const item = provider.getTreeItem(node!);
    expect(item.label).toBe("web");
    expect(item.description).toBe("1/2 · 2d");
    expect(item.contextValue).toBe("k8sview.resource:apps/Deployment");
    expect((item.iconPath as { id: string; color?: { id: string } }).color?.id).toBe("list.warningForeground");
    expect(item.id).toBe(`deployments/${d.uid}`);
  });

  test("resource children, field items and collapse releases leases", () => {
    const [deployments] = provider.getChildren();
    const d = res(kinds.deployment, "web", {}, "a");
    source.set({ group: "apps", kind: "Deployment" }, "a", [d]);
    const [dNode] = provider.getChildren(deployments);
    const pod = res(
      kinds.pod,
      "web-1",
      {
        metadata: {
          name: "web-1",
          uid: "p1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: d.uid }],
        },
        spec: { containers: [{ name: "app", image: "nginx" }] },
      },
      "a",
    );
    provider.getChildren(dNode);
    source.set({ group: "", kind: "Pod" }, "a", [pod]);
    const [podNode] = provider.getChildren(dNode);
    expect(provider.getTreeItem(podNode!).label).toBe("web-1");
    const [container] = provider.getChildren(podNode);
    // Pod containers have their own contextValue for the "Logs" menu.
    expect(provider.getTreeItem(container!).contextValue).toBe("k8sview.field:/Pod:container");
    expect(source.active()).toContain("/Pod|a");
    provider.collapsed(dNode!);
    expect(source.active()).toEqual(["apps/Deployment|a"]);
    provider.collapsed(deployments!);
    expect(source.active()).toEqual([]);
  });

  test("titled child relations become folders", () => {
    const [, sas] = provider.getChildren();
    source.set({ group: "", kind: "ServiceAccount" }, "a", [res(kinds.serviceAccount, "builder", {}, "a")]);
    const [sa] = provider.getChildren(sas);
    const [folder] = provider.getChildren(sa);
    expect(provider.getTreeItem(folder!).label).toBe("RoleBindings");
  });
});

describe("ResourceTreeProvider: single-section views, labels, port-forwards", () => {
  const view = {
    version: 1,
    views: [
      {
        id: "svc",
        title: "Service",
        portForwards: true,
        sections: [
          {
            id: "pods",
            title: "Pods",
            resources: [{ kind: "Pod" }],
            label: "${$.metadata.labels.app}",
            status: {
              rules: [
                {
                  when: { path: "$.status.phase", op: "eq", value: "Succeeded" },
                  level: "ok",
                  icon: "circle-filled",
                  color: "disabledForeground",
                },
              ],
              default: "unknown",
            },
          },
        ],
      },
      {
        id: "crd",
        title: "CRD",
        sections: [{ id: "x", title: "X", resources: [{ group: "example.io", kind: "Widget" }] }],
      },
    ],
  };
  const forwards = new EventEmitter<void>();
  let running: PortForwardInfo[];
  let manager: ViewSessionManager;

  beforeEach(async () => {
    const settings = new FakeSettings();
    const contexts = new ContextService(
      new FakeKubeConfig([{ name: "dev", cluster: "dev", user: "u", namespace: "a" }], "dev"),
      new FakeState(),
      settings,
      new FakeClusterApi(),
    );
    await contexts.initialize();
    source = new FakeResourceSource();
    source.addKind(kinds.pod);
    const registry = new ViewRegistry();
    registry.apply(
      [{ id: "f", origin: "builtin", parsed: parseConfigText(JSON.stringify(view)) }],
      { trusted: true, isPresetActive: () => true },
      new Map(),
    );
    manager = new ViewSessionManager(registry, contexts, source, settings);
    await manager.session("svc")!.whenReady();
    await manager.session("crd")!.whenReady();
    running = [];
    provider = new ResourceTreeProvider(manager, "svc", {
      onDidChange: forwards.event,
      list: (context) => running.filter((r) => r.request.context === context),
    });
  });

  test("port-forwards of the context come first; the only section is expanded", () => {
    const [pf, pods] = provider.getChildren();
    expect(provider.getTreeItem(pf!).label).toBe("Port-forwards");
    expect(provider.getTreeItem(pods!).collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(labels(provider.getChildren(pf))).toEqual(["None — use Port-forward… on a Service or Pod"]);
    const request = { context: "dev", kind: "service", namespace: "a", name: "web", ports: "8080:80" };
    running = [
      { id: 1, request, state: "active", localPorts: [8080], startedAt: Date.now() },
      { id: 2, request: { ...request, context: "prod" }, state: "active", localPorts: [9090], startedAt: Date.now() },
    ];
    forwards.fire();
    const [item] = provider.getChildren(pf);
    const ti = provider.getTreeItem(item!);
    expect(ti.label).toBe("service/web");
    expect(ti.description).toBe("8080:80 · a");
    expect(ti.contextValue).toBe("k8sview.portForward");
  });

  test("label template and status-rule icon/color", () => {
    const [, pods] = provider.getChildren();
    source.set({ group: "", kind: "Pod" }, "a", [
      res(
        kinds.pod,
        "job-abc",
        { metadata: { name: "job-abc", uid: "job-abc", labels: { app: "report" } }, status: { phase: "Succeeded" } },
        "a",
      ),
    ]);
    const [pod] = provider.getChildren(pods);
    const item = provider.getTreeItem(pod!);
    expect(item.label).toBe("report");
    expect(item.iconPath).toMatchObject({ id: "circle-filled", color: { id: "disabledForeground" } });
  });

  test("a view whose kinds are all missing says so instead of an empty tree", () => {
    const crd = new ResourceTreeProvider(manager, "crd");
    expect(crd.getChildren().map((n) => crd.getTreeItem(n).label)).toEqual([
      "None of the kinds of this view are served by this cluster",
    ]);
  });
});

describe("ResourceTreeProvider: failing resources", () => {
  const view = {
    version: 1,
    views: [
      {
        id: "flux",
        title: "Flux",
        sections: [
          {
            id: "ks",
            title: "Kustomizations",
            resources: [{ group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" }],
            status: { preset: "readyCondition" },
            description: "${$.status.lastAppliedRevision}",
          },
        ],
      },
    ],
  };
  const ready = (status: string, reason: string, message: string, revision?: string) => ({
    status: {
      conditions: [{ type: "Ready", status, reason, message }],
      ...(revision ? { lastAppliedRevision: revision } : {}),
    },
  });

  beforeEach(async () => {
    const settings = new FakeSettings();
    const contexts = new ContextService(
      new FakeKubeConfig([{ name: "dev", cluster: "dev", user: "u", namespace: "a" }], "dev"),
      new FakeState(),
      settings,
      new FakeClusterApi(),
    );
    await contexts.initialize();
    source = new FakeResourceSource();
    source.addKind(kinds.kustomization);
    const registry = new ViewRegistry();
    registry.apply(
      [{ id: "f", origin: "builtin", parsed: parseConfigText(JSON.stringify(view)) }],
      { trusted: true, isPresetActive: () => true },
      new Map(),
    );
    const manager = new ViewSessionManager(registry, contexts, source, settings);
    await manager.session("flux")!.whenReady();
    provider = new ResourceTreeProvider(manager, "flux");
  });

  const itemFor = (object: Record<string, unknown>) => {
    const [ks] = provider.getChildren();
    source.set({ group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" }, "a", [
      res(kinds.kustomization, "apps", object, "a"),
    ]);
    const [node] = provider.getChildren(ks);
    return provider.getTreeItem(node!);
  };

  test("an error resource shows its reason before the description template", () => {
    const item = itemFor(
      ready("False", "ArtifactFailed", "Source artifact not found, retrying in 30s", "main@sha1:abc"),
    );
    expect(item.description).toBe("ArtifactFailed · main@sha1:abc");
  });

  test("an error resource with an empty description template still shows its reason", () => {
    expect(itemFor(ready("False", "ArtifactFailed", "Source artifact not found")).description).toBe("ArtifactFailed");
  });

  test("a healthy resource keeps the plain description", () => {
    const item = itemFor(ready("True", "ReconciliationSucceeded", "Applied revision", "main@sha1:abc"));
    expect(item.description).toBe("main@sha1:abc");
  });

  test("the tooltip lists the condition messages", () => {
    const tooltip = itemFor(ready("False", "ArtifactFailed", "Source artifact not found, retrying in 30s")).tooltip as {
      value: string;
    };
    expect(tooltip.value).toContain("Source artifact not found, retrying in 30s");
  });
});
