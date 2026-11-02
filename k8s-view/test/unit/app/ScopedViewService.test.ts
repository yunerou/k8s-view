import { beforeEach, describe, expect, test } from "vitest";
import { ContextService } from "../../../src/app/ContextService";
import { ScopedViewService } from "../../../src/app/ScopedViewService";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import type { KubeResource } from "../../../src/core/resource/KubeResource";
import { scopeSourceOf } from "../../../src/core/view/ScopeResolver";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

const owner = (r: KubeResource) => ({ apiVersion: r.kind.apiVersion, kind: r.kind.kind, name: r.name, uid: r.uid });

let registry: ViewRegistry;
let contexts: ContextService;
let source: FakeResourceSource;
let service: ScopedViewService;

const deploy = res(kinds.deployment, "web", {}, "a");
const rs = res(
  kinds.replicaSet,
  "web-1",
  { metadata: { name: "web-1", uid: "rs-svc", ownerReferences: [owner(deploy)] } },
  "a",
);
const pod = res(
  kinds.pod,
  "web-1-x",
  { metadata: { name: "web-1-x", uid: "pod-svc", ownerReferences: [owner(rs)] } },
  "a",
);

beforeEach(async () => {
  const settings = new FakeSettings();
  contexts = new ContextService(
    new FakeKubeConfig(
      [
        { name: "dev", cluster: "dev", user: "u", namespace: "a" },
        { name: "prod", cluster: "prod", user: "u", namespace: "a" },
      ],
      "dev",
    ),
    new FakeState(),
    settings,
    new FakeClusterApi(),
  );
  await contexts.initialize();
  source = new FakeResourceSource();
  source.addKind(kinds.deployment, kinds.replicaSet, kinds.pod, kinds.configMap);
  source.set({ group: "apps", kind: "Deployment" }, "a", [deploy]);
  source.set({ group: "apps", kind: "ReplicaSet" }, "a", [rs]);
  source.set({ group: "", kind: "Pod" }, "a", [pod]);
  registry = new ViewRegistry();
  const parsed = parseConfigText(
    JSON.stringify({
      version: 1,
      views: [
        {
          id: "workload",
          title: "Workload",
          order: 1,
          sections: [
            {
              id: "deployments",
              title: "Deployments",
              resources: [{ group: "apps", kind: "Deployment" }],
              children: [
                {
                  id: "rs",
                  relation: { type: "ownerRef", group: "apps", kind: "ReplicaSet" },
                  children: [{ id: "pods", relation: { type: "ownerRef", kind: "Pod" } }],
                },
              ],
            },
            {
              id: "pods",
              title: "Pods",
              resources: [{ kind: "Pod" }],
              filter: { path: "$.status.phase", op: "neq", value: "Succeeded" },
              groupBy: "namespace",
              columns: [{ title: "Node", path: "$.spec.nodeName" }],
            },
          ],
        },
      ],
    }),
  );
  registry.apply([{ id: "t", origin: "builtin", parsed }], { trusted: true, isPresetActive: () => true }, new Map());
  service = new ScopedViewService(registry, contexts, source);
});

describe("ScopedViewService", () => {
  test("Open Related builds one section per related kind with template columns", () => {
    const id = service.ensure("related", scopeSourceOf(deploy));
    expect(id).toBe(`related.${deploy.uid}`);
    const view = registry.get(id!)!;
    expect(view.title).toBe("Related · Deployment a/web");
    expect(view.dynamic).toBe(true);
    expect(view.scope?.direction).toBe("related");
    const sections = view.definition.sections;
    expect(sections.map((s) => s.id)).toEqual(["replicaset.apps", "pod"]);
    expect(sections[1]!.columns.map((c) => c.title)).toEqual(["Node"]);
    expect(sections[1]!.groupBy).toBeUndefined();
    expect(sections[1]!.filter).toBeUndefined();
    expect(registry.views().map((v) => v.id)).toEqual(["workload"]);
  });

  test("ensure is idempotent", () => {
    const first = service.ensure("related", scopeSourceOf(deploy));
    const view = registry.get(first!);
    expect(service.ensure("related", scopeSourceOf(deploy))).toBe(first);
    expect(registry.get(first!)).toBe(view);
  });

  test("Open Parent lists the ancestor kinds found", () => {
    const id = service.ensure("parents", scopeSourceOf(pod));
    expect(registry.get(id!)!.definition.sections.map((s) => s.id)).toEqual(["replicaset.apps", "deployment.apps"]);
  });

  test("kinds without relations open nothing", () => {
    const cm = res(kinds.configMap, "cm", {}, "a");
    expect(service.ensure("related", scopeSourceOf(cm))).toBeUndefined();
    expect(service.ensure("parents", scopeSourceOf(cm))).toBeUndefined();
  });

  test("remove and context changes drop scoped views", async () => {
    const id = service.ensure("related", scopeSourceOf(deploy))!;
    service.remove(id);
    expect(registry.get(id)).toBeUndefined();
    const again = service.ensure("related", scopeSourceOf(deploy))!;
    await contexts.selectContext("prod");
    expect(registry.get(again)).toBeUndefined();
  });

  test("namespace changes keep scoped views; only a context switch clears them", async () => {
    const id = service.ensure("related", scopeSourceOf(deploy))!;
    await contexts.selectNamespace({ type: "single", name: "b" });
    await contexts.selectNamespace({ type: "all" });
    expect(registry.get(id)?.scope).toBeDefined();
    await contexts.selectContext("prod");
    expect(registry.get(id)).toBeUndefined();
  });
});
