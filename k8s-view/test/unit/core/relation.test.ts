import { describe, expect, test } from "vitest";
import { RelationSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import type { KubeResource } from "../../../src/core/resource/KubeResource";
import { type ChildItem, CompiledRelation, type ResourceLookup } from "../../../src/core/view/RelationResolver";
import { kinds, res } from "../helpers/fixtures";

const engine = new ExpressionEngine("safe");

function lookupOf(items: KubeResource[], loaded = true): ResourceLookup {
  return {
    list(group, kind, namespace) {
      if (!loaded) return undefined;
      return items.filter(
        (r) =>
          r.kind.group === group &&
          r.kind.kind === kind &&
          (namespace === undefined || !r.kind.namespaced || r.namespace === namespace),
      );
    },
    byOwner(group, kind, uid) {
      if (!loaded) return undefined;
      return items.filter((r) => r.kind.group === group && r.kind.kind === kind && r.ownerUids.includes(uid));
    },
  };
}

const rel = (cfg: unknown) => new CompiledRelation(RelationSchema.parse(cfg), engine);
const names = (items: ChildItem[]) =>
  items.map((i) => (i.type === "resource" ? i.resource.name : i.type === "field" ? i.label : `missing:${i.name}`));

describe("ownerRef", () => {
  const deploy = res(kinds.deployment, "web");
  const rs = res(kinds.replicaSet, "web-1", {
    metadata: {
      name: "web-1",
      uid: "rs1",
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: deploy.uid }],
    },
  });
  const otherRs = res(kinds.replicaSet, "api-1");

  test("finds children owned by parent uid", () => {
    const r = rel({ type: "ownerRef", group: "apps", kind: "ReplicaSet" }).resolve(deploy, lookupOf([rs, otherRs]));
    expect(names(r.items)).toEqual(["web-1"]);
    expect(r.demands).toEqual([{ group: "apps", kind: "ReplicaSet", namespace: "default" }]);
    expect(r.pending).toBe(false);
  });

  test("pending when kind not loaded", () => {
    const r = rel({ type: "ownerRef", group: "apps", kind: "ReplicaSet" }).resolve(deploy, lookupOf([], false));
    expect(r.pending).toBe(true);
    expect(r.items).toEqual([]);
  });
});

describe("labelSelector", () => {
  test("service selector map selects pods in same namespace", () => {
    const svc = res(kinds.service, "web", { spec: { selector: { app: "web" } } }, "a");
    const p1 = res(kinds.pod, "web-1", { metadata: { name: "web-1", uid: "p1", labels: { app: "web" } } }, "a");
    const p2 = res(kinds.pod, "web-2", { metadata: { name: "web-2", uid: "p2", labels: { app: "web" } } }, "b");
    const r = rel({ type: "labelSelector", kind: "Pod", selector: "$.spec.selector" }).resolve(svc, lookupOf([p1, p2]));
    expect(names(r.items)).toEqual(["web-1"]);
  });
});

describe("fieldRef", () => {
  test("Kustomization sourceRef → GitRepository using defaults", () => {
    const ks = res(
      kinds.kustomization,
      "apps",
      { spec: { sourceRef: { kind: "GitRepository", name: "repo" } } },
      "flux",
    );
    const repo = res(kinds.gitRepository, "repo", {}, "flux");
    const r = rel({
      type: "fieldRef",
      items: "$.spec.sourceRef",
      group: { path: "$.apiVersion", default: "source.toolkit.fluxcd.io" },
      kind: { path: "$.kind", default: "GitRepository" },
    }).resolve(ks, lookupOf([repo]));
    expect(names(r.items)).toEqual(["repo"]);
    expect(r.demands).toEqual([{ group: "source.toolkit.fluxcd.io", kind: "GitRepository", namespace: "flux" }]);
  });

  test("HTTPRoute backendRefs → Services, namespace override and missing target", () => {
    const route = res(
      kinds.httpRoute,
      "r",
      {
        spec: {
          rules: [{ backendRefs: [{ name: "web", port: 80 }, { name: "api", namespace: "other" }, { name: "gone" }] }],
        },
      },
      "a",
    );
    const web = res(kinds.service, "web", {}, "a");
    const api = res(kinds.service, "api", {}, "other");
    const r = rel({
      type: "fieldRef",
      items: "$.spec.rules[*].backendRefs[*]",
      group: { path: "$.group", default: "" },
      kind: { path: "$.kind", default: "Service" },
      namespace: "$.namespace",
    }).resolve(route, lookupOf([web, api]));
    expect(names(r.items)).toEqual(["web", "api", "missing:gone"]);
    expect(r.demands).toEqual([
      { group: "", kind: "Service", namespace: "a" },
      { group: "", kind: "Service", namespace: "other" },
    ]);
  });

  test("apiVersion values are reduced to their group, core versions to ''", () => {
    const rb = res(kinds.roleBinding, "rb", {
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view" },
    });
    const view = res(kinds.clusterRole, "view");
    const r = rel({
      type: "fieldRef",
      items: "$.roleRef",
      group: { path: "$.apiGroup", default: "rbac.authorization.k8s.io" },
      kind: { path: "$.kind", default: "Role" },
    }).resolve(rb, lookupOf([view]));
    expect(names(r.items)).toEqual(["view"]);
  });
});

describe("reverseFieldRef", () => {
  const sa = res(kinds.serviceAccount, "builder", {}, "ci");
  const rb1 = res(
    kinds.roleBinding,
    "rb-ci",
    { subjects: [{ kind: "ServiceAccount", name: "builder", namespace: "ci" }] },
    "ci",
  );
  const rb2 = res(
    kinds.roleBinding,
    "rb-other-ns",
    { subjects: [{ kind: "ServiceAccount", name: "builder", namespace: "ci" }] },
    "prod",
  );
  const rb3 = res(
    kinds.roleBinding,
    "rb-wrong",
    { subjects: [{ kind: "ServiceAccount", name: "builder", namespace: "dev" }] },
    "ci",
  );
  const rb4 = res(
    kinds.roleBinding,
    "rb-group",
    { subjects: [{ kind: "Group", name: "system:serviceaccounts:ci" }] },
    "ci",
  );
  const cfg = {
    type: "reverseFieldRef",
    group: "rbac.authorization.k8s.io",
    kind: "RoleBinding",
    items: "$.subjects[?(@.kind=='ServiceAccount')]",
    match: { name: "${name}", namespace: "${namespace}" },
    allNamespaces: true,
  };

  test("finds bindings in all namespaces that reference the parent", () => {
    const r = rel(cfg).resolve(sa, lookupOf([rb1, rb2, rb3, rb4]));
    expect(names(r.items)).toEqual(["rb-ci", "rb-other-ns"]);
    expect(r.demands).toEqual([{ group: "rbac.authorization.k8s.io", kind: "RoleBinding", namespace: undefined }]);
  });

  test("group subjects via templated match name", () => {
    const r = rel({
      ...cfg,
      items: "$.subjects[?(@.kind=='Group')]",
      match: { name: "system:serviceaccounts:${namespace}" },
    }).resolve(sa, lookupOf([rb1, rb4]));
    expect(names(r.items)).toEqual(["rb-group"]);
  });
});

describe("field", () => {
  test("array items with label template", () => {
    const pod = res(kinds.pod, "p", {
      spec: {
        containers: [
          { name: "app", image: "nginx" },
          { name: "side", image: "envoy" },
        ],
      },
    });
    const r = rel({
      type: "field",
      items: "$.spec.containers[*]",
      label: "${$.name}",
      description: "${$.image}",
    }).resolve(pod, lookupOf([]));
    expect(r.items).toMatchObject([
      { type: "field", label: "app", description: "nginx", index: 0 },
      { type: "field", label: "side", description: "envoy", index: 1 },
    ]);
    expect(r.demands).toEqual([]);
  });

  test("object becomes key/value entries", () => {
    const cm = res(kinds.configMap, "c", { data: { "a.conf": "x=1", b: "2" } });
    const r = rel({ type: "field", items: "$.data", label: "${key}", description: "${$.value|trunc:3}" }).resolve(
      cm,
      lookupOf([]),
    );
    expect(r.items).toMatchObject([
      { type: "field", label: "a.conf", key: "a.conf", description: "x=1" },
      { type: "field", label: "b", key: "b", description: "2" },
    ]);
  });
});
