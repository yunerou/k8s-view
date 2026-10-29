import { beforeEach, describe, expect, test } from "vitest";
import { ClusterContext } from "../../../src/core/context/ClusterContext";
import type { KubeObject } from "../../../src/core/resource/KubeResource";
import type { ResourceKind } from "../../../src/core/resource/ResourceKind";
import { DiscoveryService } from "../../../src/infra/kube/DiscoveryService";
import { KubeResourceSource } from "../../../src/infra/kube/KubeResourceSource";
import { KubeTransport, type ListResult, type WatchHandle } from "../../../src/infra/kube/KubeTransport";
import { WatchManager } from "../../../src/infra/kube/WatchManager";
import { FakeSettings } from "../helpers/fakes";

class FakeTransport extends KubeTransport {
  async streamText(): Promise<void> {}
  data = new Map<string, KubeObject[]>();
  errors = new Map<string, number>();
  json = new Map<string, unknown>();
  async list(_context: string, kind: ResourceKind, ns: string | undefined): Promise<ListResult> {
    const key = `${kind.key}|${ns ?? "*"}`;
    const status = this.errors.get(key);
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
    return { items: this.data.get(key) ?? [], resourceVersion: "1" };
  }
  async watch(): Promise<WatchHandle> {
    return { abort() {} };
  }
  async getJson<T>(_c: string, path: string): Promise<T> {
    const v = this.json.get(path);
    if (v === undefined) throw Object.assign(new Error("404"), { status: 404 });
    return v as T;
  }
}

const obj = (kind: string, name: string, ns: string | undefined, extra: Record<string, unknown> = {}): KubeObject => ({
  metadata: { name, uid: `${kind}-${ns}-${name}`, resourceVersion: "1", ...(ns ? { namespace: ns } : {}) },
  ...extra,
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let transport: FakeTransport;
let source: KubeResourceSource;
const ctxA = new ClusterContext("dev", "dev", "u", { type: "single", name: "a" }, false);

beforeEach(() => {
  transport = new FakeTransport();
  transport.json.set("/api/v1", {
    resources: [
      { name: "pods", kind: "Pod", namespaced: true },
      { name: "secrets", kind: "Secret", namespaced: true },
      { name: "namespaces", kind: "Namespace", namespaced: false },
    ],
  });
  transport.json.set("/apis", {
    groups: [
      {
        name: "rbac.authorization.k8s.io",
        versions: [{ groupVersion: "rbac.authorization.k8s.io/v1", version: "v1" }],
        preferredVersion: { version: "v1" },
      },
    ],
  });
  transport.json.set("/apis/rbac.authorization.k8s.io/v1", {
    resources: [
      { name: "rolebindings", kind: "RoleBinding", namespaced: true },
      { name: "clusterroles", kind: "ClusterRole", namespaced: false },
    ],
  });
  const settings = new FakeSettings();
  const discovery = new DiscoveryService(transport);
  const watches = new WatchManager(transport, discovery, settings, { info() {}, warn() {} });
  source = new KubeResourceSource(watches, discovery, transport);
});

describe("KubeResourceSource.lookup", () => {
  test("undefined while loading, then items of the namespace entry", async () => {
    transport.data.set("/Pod|a", [obj("Pod", "p1", "a")]);
    source.acquire(ctxA, { group: "", kind: "Pod" }, "a");
    expect(source.lookup(ctxA).list("", "Pod", "a")).toBeUndefined();
    await flush();
    expect(
      source
        .lookup(ctxA)
        .list("", "Pod", "a")
        ?.map((r) => r.name),
    ).toEqual(["p1"]);
  });

  test("a cluster-wide entry serves namespace lookups", async () => {
    transport.data.set("/Pod|*", [obj("Pod", "p1", "a"), obj("Pod", "p2", "b")]);
    source.acquire(ctxA, { group: "", kind: "Pod" }, undefined);
    await flush();
    expect(
      source
        .lookup(ctxA)
        .list("", "Pod", "b")
        ?.map((r) => r.name),
    ).toEqual(["p2"]);
    expect(
      source
        .lookup(ctxA)
        .list("", "Pod", undefined)
        ?.map((r) => r.name),
    ).toEqual(["p1", "p2"]);
  });

  test("cluster-scoped kinds ignore the namespace", async () => {
    transport.data.set("rbac.authorization.k8s.io/ClusterRole|a", [obj("ClusterRole", "view", undefined)]);
    source.acquire(ctxA, { group: "rbac.authorization.k8s.io", kind: "ClusterRole" }, "a");
    await flush();
    expect(
      source
        .lookup(ctxA)
        .list("rbac.authorization.k8s.io", "ClusterRole", "zzz")
        ?.map((r) => r.name),
    ).toEqual(["view"]);
  });

  test("unknown kinds resolve to an empty list", async () => {
    source.acquire(ctxA, { group: "x.io", kind: "Nope" }, "a");
    await flush();
    expect(source.lookup(ctxA).list("x.io", "Nope", "a")).toEqual([]);
  });

  test("forbidden cluster-wide entry falls back to the selected namespace entry", async () => {
    transport.errors.set("rbac.authorization.k8s.io/RoleBinding|*", 403);
    transport.data.set("rbac.authorization.k8s.io/RoleBinding|a", [obj("RoleBinding", "rb", "a")]);
    source.acquire(ctxA, { group: "rbac.authorization.k8s.io", kind: "RoleBinding" }, undefined);
    await flush();
    expect(
      source.lookup(ctxA).entry({ group: "rbac.authorization.k8s.io", kind: "RoleBinding" }, undefined)?.state,
    ).toBe("forbidden");
    expect(source.lookup(ctxA).list("rbac.authorization.k8s.io", "RoleBinding", undefined)).toEqual([]);
    source.acquire(ctxA, { group: "rbac.authorization.k8s.io", kind: "RoleBinding" }, "a");
    await flush();
    expect(
      source
        .lookup(ctxA)
        .list("rbac.authorization.k8s.io", "RoleBinding", undefined)
        ?.map((r) => r.name),
    ).toEqual(["rb"]);
  });

  test("byOwner merges loaded entries", async () => {
    const owner = { ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "rs", uid: "rs1" }] };
    transport.data.set("/Pod|a", [
      obj("Pod", "p1", "a"),
      { ...obj("Pod", "p2", "a"), metadata: { ...obj("Pod", "p2", "a").metadata, ...owner } },
    ]);
    expect(source.lookup(ctxA).byOwner("", "Pod", "rs1")).toBeUndefined();
    source.acquire(ctxA, { group: "", kind: "Pod" }, "a");
    await flush();
    expect(
      source
        .lookup(ctxA)
        .byOwner("", "Pod", "rs1")
        ?.map((r) => r.name),
    ).toEqual(["p2"]);
  });

  test("secret values come from a fresh GET and are decoded", async () => {
    transport.json.set("/api/v1/namespaces/a/secrets/s", {
      metadata: { name: "s", uid: "s" },
      data: { pw: Buffer.from("hunter2").toString("base64") },
    });
    expect(await source.readSecretValue(ctxA, "a", "s", "pw")).toBe("hunter2");
    await expect(source.readSecretValue(ctxA, "a", "s", "nope")).rejects.toThrow(/no key 'nope'/);
  });
});
