import { describe, expect, test } from "vitest";
import type { KubeResource } from "../../../src/core/resource/KubeResource";
import { ParentIndex } from "../../../src/core/view/ParentIndex";
import { kinds, res } from "../helpers/fixtures";
import { eventKind, lookupOf, nodeKind, testViews } from "../helpers/relationViews";

const owner = (r: KubeResource) => ({ apiVersion: r.kind.apiVersion, kind: r.kind.kind, name: r.name, uid: r.uid });

describe("ParentIndex", () => {
  const index = ParentIndex.build(testViews);
  const deploy = res(kinds.deployment, "web", {}, "app");
  const rs = res(
    kinds.replicaSet,
    "web-1",
    { metadata: { name: "web-1", uid: "rs-1", ownerReferences: [owner(deploy)] } },
    "app",
  );
  const pod = res(
    kinds.pod,
    "web-1-x",
    {
      metadata: { name: "web-1-x", uid: "pod-1", labels: { app: "web" }, ownerReferences: [owner(rs)] },
      spec: { nodeName: "n1" },
    },
    "app",
  );
  const node = res(nodeKind, "n1");
  const svc = res(kinds.service, "web", { spec: { selector: { app: "web" } } }, "app");
  const route = res(
    kinds.httpRoute,
    "edge",
    { spec: { rules: [{ backendRefs: [{ name: "web", namespace: "app" }] }] } },
    "gw",
  );
  const event = res(eventKind, "e1", { involvedObject: { kind: "Pod", name: "web-1-x", namespace: "app" } }, "app");
  const lookup = lookupOf([deploy, rs, pod, node, svc, route, event]);

  test("a pod's parents: owner, node and selecting service; events are not parents", () => {
    const hits = index.parents(pod, lookup, false).items.map((h) => [h.resource.kind.kind, h.resource.name, h.via]);
    expect(hits).toEqual(
      expect.arrayContaining([
        ["ReplicaSet", "web-1", ["owner"]],
        ["Node", "n1", ["referencedBy"]],
        ["Service", "web", ["selects"]],
      ]),
    );
    expect(hits).toHaveLength(3);
  });

  test("routes in other namespaces are parents of a service only with allNamespaces", () => {
    expect(index.parents(svc, lookup, false).items).toEqual([]);
    expect(index.parents(svc, lookup, true).items.map((h) => [h.resource.name, h.via])).toEqual([
      ["edge", ["references"]],
    ]);
  });

  test("demands cover owner and parent kinds", () => {
    const { demands } = index.parents(pod, lookup, false);
    expect(demands).toEqual(
      expect.arrayContaining([
        { group: "apps", kind: "ReplicaSet", namespace: "app" },
        { group: "", kind: "Node", namespace: undefined },
        { group: "", kind: "Service", namespace: "app" },
      ]),
    );
  });

  test("ancestorKinds follows configured edges, including ownerRef chains, but not Events", () => {
    const kindsOf = index.ancestorKinds({ group: "", kind: "Pod" }).map((k) => k.kind);
    expect(kindsOf).toEqual(expect.arrayContaining(["ReplicaSet", "Deployment", "Node", "Service", "HTTPRoute"]));
    expect(kindsOf).not.toContain("Event");
    expect(kindsOf).not.toContain("Pod");
  });

  test("hasParents: owners or a configured edge", () => {
    expect(index.hasParents(rs)).toBe(true);
    expect(index.hasParents(deploy)).toBe(false);
    expect(index.hasParents(res(kinds.configMap, "cm"))).toBe(false);
  });

  test("empty index only knows owners", () => {
    expect(ParentIndex.empty.parents(rs, lookup, false).items.map((h) => h.resource.name)).toEqual(["web"]);
  });
});
