import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContextService } from "../../../src/app/ContextService";
import type { RegisteredView } from "../../../src/app/ViewRegistry";
import { ViewSession } from "../../../src/app/ViewSession";
import { ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import { kindViewConfig } from "../../../src/core/view/kindView";
import { compileView } from "../../../src/core/view/ViewDefinition";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

const engine = new ExpressionEngine("safe");

function registered(config: unknown): RegisteredView {
  const { view } = compileView(ViewSchema.parse(config), engine);
  return {
    id: view.id,
    title: view.title,
    definition: view,
    origin: "builtin",
    fileId: "x",
    index: 0,
    untrusted: false,
  };
}

const workload = registered({
  id: "workload",
  title: "Workload",
  sections: [
    {
      id: "deployments",
      title: "Deployments",
      resources: [{ group: "apps", kind: "Deployment" }],
      children: [{ id: "rs", relation: { type: "ownerRef", group: "apps", kind: "ReplicaSet" } }],
    },
    {
      id: "pods",
      title: "Pods",
      resources: [{ kind: "Pod" }],
      filter: { path: "$.status.phase", op: "neq", value: "Succeeded" },
    },
    { id: "gateways", title: "Gateways", resources: [{ group: "gateway.networking.k8s.io", kind: "Gateway" }] },
  ],
});

const deployRef = { group: "apps", kind: "Deployment" };
const rsRef = { group: "apps", kind: "ReplicaSet" };
const podRef = { group: "", kind: "Pod" };

let source: FakeResourceSource;
let contexts: ContextService;
let settings: FakeSettings;

async function makeSession(view = workload) {
  const session = new ViewSession(view, contexts, source, settings);
  session.setVisible(true);
  await session.whenReady();
  return session;
}

beforeEach(async () => {
  source = new FakeResourceSource();
  source.addKind(kinds.deployment, kinds.replicaSet, kinds.pod, kinds.serviceAccount, kinds.roleBinding);
  settings = new FakeSettings();
  const kubeconfig = new FakeKubeConfig(
    [
      { name: "dev", cluster: "dev", user: "u", namespace: "team-a" },
      { name: "prod", cluster: "prod", user: "u", namespace: undefined },
    ],
    "dev",
  );
  contexts = new ContextService(kubeconfig, new FakeState(), settings, new FakeClusterApi());
  await contexts.initialize();
});

describe("ViewSession sections", () => {
  test("hides sections whose kinds are not served by the cluster", async () => {
    const session = await makeSession();
    expect(session.sections().map((s) => s.id)).toEqual(["deployments", "pods"]);
  });

  test("view with missing required groups is unavailable", async () => {
    const session = await makeSession(
      registered({ ...workload.definition.config, requires: ["kustomize.toolkit.fluxcd.io"] }),
    );
    expect(session.available).toBe(false);
  });

  test("openSection acquires a lease in the selected namespace and reports loading", async () => {
    const session = await makeSession();
    const content = session.openSection("pods");
    expect(source.active()).toEqual(["/Pod|team-a"]);
    expect(content.state).toBe("loading");
  });

  test("items are filtered and sorted by name", async () => {
    const session = await makeSession();
    session.openSection("pods");
    source.set(podRef, "team-a", [
      res(kinds.pod, "b", { status: { phase: "Running" } }, "team-a"),
      res(kinds.pod, "done", { status: { phase: "Succeeded" } }, "team-a"),
      res(kinds.pod, "a", { status: { phase: "Running" } }, "team-a"),
    ]);
    const content = session.openSection("pods");
    expect(content.state).toBe("ready");
    expect(content.items.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("closeSection releases the lease", async () => {
    const session = await makeSession();
    session.openSection("pods");
    session.closeSection("pods");
    expect(source.active()).toEqual([]);
  });

  test("tree and table hold separate section leases", async () => {
    const session = await makeSession();
    session.openSection("pods");
    session.openSection("pods", "table");
    session.closeSection("pods");
    expect(source.active()).toEqual(["/Pod|team-a"]);
    session.closeSection("pods", "table");
    expect(source.active()).toEqual([]);
  });

  test("allNamespaces sections list every namespace whatever namespace is selected", async () => {
    const session = await makeSession(
      registered({
        id: "events",
        title: "Events",
        sections: [{ id: "all", title: "All", resources: [{ kind: "Pod" }], allNamespaces: true }],
      }),
    );
    session.openSection("all");
    expect(source.active()).toEqual(["/Pod|*"]);
    source.set(podRef, undefined, [res(kinds.pod, "x", {}, "team-b"), res(kinds.pod, "y", {}, "team-a")]);
    expect(session.openSection("all").items.map((r) => r.namespace)).toEqual(["team-b", "team-a"]);
  });

  test("forbidden kinds surface as problems", async () => {
    const session = await makeSession();
    source.setState(podRef, "team-a", { state: "forbidden", message: "pods is forbidden" });
    const content = session.openSection("pods");
    expect(content.problems).toEqual([{ kind: "Pod", state: "forbidden", message: "pods is forbidden" }]);
  });
});

describe("ViewSession children", () => {
  test("resolves ownerRef children and holds leases per node until closed", async () => {
    const session = await makeSession();
    const d = res(kinds.deployment, "web", {}, "team-a");
    const rs = res(
      kinds.replicaSet,
      "web-1",
      {
        metadata: {
          name: "web-1",
          uid: "rs1",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: d.uid }],
        },
      },
      "team-a",
    );
    const defs = session.sectionDefinition("deployments")!.children;
    let groups = session.openChildren("deployments/web", d, defs);
    expect(groups[0]!.pending).toBe(true);
    expect(source.active()).toEqual(["apps/ReplicaSet|team-a"]);
    source.set(rsRef, "team-a", [rs]);
    groups = session.openChildren("deployments/web", d, defs);
    expect(groups[0]!.items.map((i) => (i.type === "resource" ? i.resource.name : "?"))).toEqual(["web-1"]);
    expect(source.active()).toEqual(["apps/ReplicaSet|team-a"]);
    session.closeNode("deployments");
    expect(source.active()).toEqual([]);
  });

  test("all-namespace scope watches child kinds cluster-wide", async () => {
    await contexts.selectNamespace({ type: "all" });
    const session = await makeSession();
    const d = res(kinds.deployment, "web", {}, "team-a");
    session.openChildren("deployments/web", d, session.sectionDefinition("deployments")!.children);
    expect(source.active()).toEqual(["apps/ReplicaSet|*"]);
  });

  test("cross-namespace reverse lookup falls back to the selected namespace on 403", async () => {
    const view = registered({
      id: "sa",
      title: "SA",
      sections: [
        {
          id: "sas",
          title: "SAs",
          resources: [{ kind: "ServiceAccount" }],
          children: [
            {
              id: "rb",
              relation: {
                type: "reverseFieldRef",
                group: "rbac.authorization.k8s.io",
                kind: "RoleBinding",
                items: "$.subjects[*]",
                match: { name: "${name}", namespace: "${namespace}" },
                allNamespaces: true,
              },
            },
          ],
        },
      ],
    });
    const session = await makeSession(view);
    const sa = res(kinds.serviceAccount, "builder", {}, "team-a");
    const defs = session.sectionDefinition("sas")!.children;
    session.openChildren("sas/builder", sa, defs);
    expect(source.active()).toEqual(["rbac.authorization.k8s.io/RoleBinding|*"]);
    source.setState({ group: "rbac.authorization.k8s.io", kind: "RoleBinding" }, undefined, {
      state: "forbidden",
      message: "forbidden",
    });
    const rb = res(
      kinds.roleBinding,
      "rb",
      { subjects: [{ kind: "ServiceAccount", name: "builder", namespace: "team-a" }] },
      "team-a",
    );
    source.set({ group: "rbac.authorization.k8s.io", kind: "RoleBinding" }, "team-a", [rb]);
    const groups = session.openChildren("sas/builder", sa, defs);
    expect(source.active()).toEqual([
      "rbac.authorization.k8s.io/RoleBinding|*",
      "rbac.authorization.k8s.io/RoleBinding|team-a",
    ]);
    expect(groups[0]!.hints[0]).toMatch(/only namespace team-a/);
    expect(groups[0]!.items.map((i) => (i.type === "resource" ? i.resource.name : "?"))).toEqual(["rb"]);
  });
});

describe("ViewSession lifecycle", () => {
  test("fires onDidChange only for kinds it watches in the current context", async () => {
    const session = await makeSession();
    let fired = 0;
    session.onDidChange(() => fired++);
    session.openSection("pods");
    source.set(deployRef, "team-a", []);
    source.set(podRef, "team-a", [], "prod");
    expect(fired).toBe(0);
    source.set(podRef, "team-a", []);
    expect(fired).toBe(1);
  });

  test("context change releases every lease and recomputes availability", async () => {
    const session = await makeSession();
    let fired = 0;
    session.onDidChange(() => fired++);
    session.openSection("pods");
    await contexts.selectContext("prod");
    await session.whenReady();
    expect(source.active()).toEqual([]);
    expect(fired).toBeGreaterThan(0);
    session.openSection("pods");
    expect(source.active()).toEqual(["/Pod|*"]);
  });

  test("hiding the view releases leases; refresh resyncs", async () => {
    const session = await makeSession();
    session.openSection("pods");
    session.setVisible(false);
    expect(source.active()).toEqual([]);
    session.refresh();
    expect(source.resynced).toBe(1);
  });
});

describe("ViewSession metrics dependencies", () => {
  const metricKind = new ResourceKind("metrics.k8s.io", "v1beta1", "PodMetrics", "pods", true);
  const metricView = registered({
    id: "metrics",
    title: "Metrics",
    sections: [
      {
        id: "pods",
        title: "Pods",
        resources: [{ kind: "Pod" }],
        columns: [{ title: "CPU", path: "$.resourceMetrics.cpu.used", render: "cpu", default: "-" }],
      },
    ],
  });

  test("metrics load independently, trigger updates and release with their section", async () => {
    source.addKind(metricKind);
    const session = await makeSession(metricView);
    source.set(podRef, "team-a", [
      res(kinds.pod, "p", { spec: { containers: [{ resources: { requests: { cpu: "1" } } }] } }, "team-a"),
    ]);
    let content = session.openSection("pods");
    expect(content.state).toBe("ready");
    expect(source.active()).toEqual(["/Pod|team-a", "metrics.k8s.io/PodMetrics|team-a"]);
    expect(content.items[0]!.object["resourceMetrics"]).toMatchObject({ cpu: { request: 1, used: undefined } });
    let fired = 0;
    session.onDidChange(() => fired++);
    source.set(metricKind, "team-a", [
      res(metricKind, "p", { containers: [{ usage: { cpu: "500m", memory: "500M" } }] }, "team-a"),
    ]);
    expect(fired).toBeGreaterThan(0);
    content = session.openSection("pods");
    expect(content.items[0]!.object["resourceMetrics"]).toMatchObject({ cpu: { used: 0.5, percent: 50 } });
    source.setState(metricKind, "team-a", { state: "error", message: "Metrics unavailable" });
    content = session.openSection("pods");
    expect(content.problems).toContainEqual({ kind: "PodMetrics", state: "error", message: "Metrics unavailable" });
    expect(content.items[0]!.object["resourceMetrics"]).toMatchObject({ cpu: { used: undefined, request: 1 } });
    session.closeSection("pods");
    expect(source.active()).toEqual([]);
    session.dispose();
  });
});

test("node metrics use cluster scope; forbidden cluster-wide Pod access leaves budgets unknown", async () => {
  const nodeKind = new ResourceKind("", "v1", "Node", "nodes", false);
  const nodeMetricKind = new ResourceKind("metrics.k8s.io", "v1beta1", "NodeMetrics", "nodes", false);
  source.addKind(nodeKind, nodeMetricKind);
  const session = await makeSession(registered(kindViewConfig({ group: "", kind: "Node" })));
  source.set(nodeKind, undefined, [res(nodeKind, "n")]);
  source.set(nodeMetricKind, undefined, [res(nodeMetricKind, "n", { usage: { cpu: "500m", memory: "500M" } })]);
  source.set(podRef, undefined, [
    res(
      kinds.pod,
      "p",
      { spec: { nodeName: "n", containers: [{ resources: { requests: { cpu: "1" } } }] } },
      "other-team",
    ),
  ]);
  const content = session.openSection("resources");
  expect(source.active()).toContain("metrics.k8s.io/NodeMetrics|*");
  expect(source.active()).toContain("/Pod|*");
  expect(content.items[0]!.object["resourceMetrics"]).toMatchObject({ cpu: { used: 0.5, request: 1, percent: 50 } });
  const refresh = vi.spyOn(source, "resync");
  session.refresh();
  expect(refresh).toHaveBeenCalledWith(
    contexts.current,
    expect.arrayContaining([
      { group: "", kind: "Pod" },
      { group: "metrics.k8s.io", kind: "NodeMetrics" },
    ]),
  );
  source.setState(podRef, undefined, { state: "forbidden", message: "No cluster-wide Pod access" });
  const forbidden = session.openSection("resources");
  expect(forbidden.problems).toContainEqual({ kind: "Pod", state: "forbidden", message: "No cluster-wide Pod access" });
  expect(forbidden.items[0]!.object["resourceMetrics"]).toMatchObject({
    cpu: { used: 0.5, request: undefined, percent: undefined },
  });
  session.setVisible(false);
  expect(source.active()).toEqual([]);
  session.dispose();
});

test("missing Metrics Server keeps Pods and their requests visible", async () => {
  const session = await makeSession(registered(kindViewConfig({ group: "", kind: "Pod" })));
  source.set(podRef, "team-a", [
    res(kinds.pod, "p", { spec: { containers: [{ resources: { requests: { cpu: "1" } } }] } }, "team-a"),
  ]);
  const content = session.openSection("resources");
  expect(content.state).toBe("ready");
  expect(content.problems).toContainEqual({ kind: "PodMetrics", state: "unavailable", message: undefined });
  expect(content.items[0]!.object["resourceMetrics"]).toMatchObject({ cpu: { used: undefined, request: 1 } });
  session.dispose();
});
