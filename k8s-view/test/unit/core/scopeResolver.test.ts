import { describe, expect, test } from "vitest";
import type { KubeResource } from "../../../src/core/resource/KubeResource";
import { ParentIndex } from "../../../src/core/view/ParentIndex";
import { resolveScope, scopeSourceOf, type ViewScope } from "../../../src/core/view/ScopeResolver";
import { kinds, res } from "../helpers/fixtures";
import { lookupOf, nodeKind, testViews } from "../helpers/relationViews";

const index = ParentIndex.build(testViews);
const owner = (r: KubeResource) => ({ apiVersion: r.kind.apiVersion, kind: r.kind.kind, name: r.name, uid: r.uid });
const sectionChildren = (viewId: string, sectionId: string) =>
  testViews.find((v) => v.id === viewId)!.sections.find((s) => s.id === sectionId)!.children;

const deploy = res(kinds.deployment, "web", {}, "app");
const rs = res(
  kinds.replicaSet,
  "web-1",
  { metadata: { name: "web-1", uid: "rs-s", ownerReferences: [owner(deploy)] } },
  "app",
);
const pod = res(
  kinds.pod,
  "web-1-x",
  {
    metadata: { name: "web-1-x", uid: "pod-s", labels: { app: "web" }, ownerReferences: [owner(rs)] },
    spec: { nodeName: "n1" },
  },
  "app",
);
const other = res(kinds.pod, "api-1", { spec: { nodeName: "n2" } }, "app");
const node = res(nodeKind, "n1");
const svc = res(kinds.service, "web", { spec: { selector: { app: "web" } } }, "app");
const route = res(kinds.httpRoute, "edge", { spec: { rules: [{ backendRefs: [{ name: "web" }] }] } }, "app");
const lookup = lookupOf([deploy, rs, pod, other, node, svc, route]);

const scope = (
  direction: ViewScope["direction"],
  source: KubeResource,
  children = sectionChildren("workload", "deployments"),
): ViewScope => ({
  direction,
  source: scopeSourceOf(source),
  context: "dev",
  children: direction === "related" ? children : [],
});
const names = (r: { found: readonly KubeResource[] }) => r.found.map((x) => x.name).sort();

describe("resolveScope", () => {
  test("related: a deployment's replica sets and pods", () => {
    const r = resolveScope(scope("related", deploy), lookup, index, false);
    expect(names(r)).toEqual(["web-1", "web-1-x"]);
    expect(r.uids.has(pod.uid)).toBe(true);
    expect(r.demands).toEqual(
      expect.arrayContaining([
        { group: "apps", kind: "Deployment", namespace: "app" },
        { group: "apps", kind: "ReplicaSet", namespace: "app" },
        { group: "", kind: "Pod", namespace: "app" },
      ]),
    );
  });

  test("related: pods on a node and pods of a service", () => {
    expect(names(resolveScope(scope("related", node, sectionChildren("node", "nodes")), lookup, index, false))).toEqual(
      ["web-1-x"],
    );
    expect(
      names(resolveScope(scope("related", svc, sectionChildren("service", "services")), lookup, index, false)),
    ).toEqual(["web-1-x"]);
  });

  test("related: services of an HTTPRoute", () => {
    expect(
      names(resolveScope(scope("related", route, sectionChildren("service", "httproutes")), lookup, index, false)),
    ).toEqual(["web"]);
  });

  test("parents: owners up the chain plus node, service and the route above the service", () => {
    expect(names(resolveScope(scope("parents", pod), lookup, index, false))).toEqual([
      "edge",
      "n1",
      "web",
      "web",
      "web-1",
    ]);
  });

  test("source missing vs. not loaded", () => {
    const gone = resolveScope(scope("related", res(kinds.deployment, "gone", {}, "app")), lookup, index, false);
    expect(gone).toMatchObject({ sourceMissing: true, pending: false, found: [] });
    const notLoaded = resolveScope(
      scope("related", deploy),
      { list: () => undefined, byOwner: () => undefined },
      index,
      false,
    );
    expect(notLoaded).toMatchObject({ sourceMissing: false, pending: true });
  });

  test("stops on cycles", () => {
    const a = res(
      kinds.replicaSet,
      "a",
      {
        metadata: {
          name: "a",
          uid: "cyc-a",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "b", uid: "cyc-b" }],
        },
      },
      "app",
    );
    const b = res(
      kinds.replicaSet,
      "b",
      {
        metadata: {
          name: "b",
          uid: "cyc-b",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "a", uid: "cyc-a" }],
        },
      },
      "app",
    );
    const r = resolveScope(scope("parents", a), lookupOf([a, b]), index, false);
    expect(names(r)).toEqual(["b"]);
  });
});
