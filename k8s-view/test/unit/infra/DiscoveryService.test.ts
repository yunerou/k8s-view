import { describe, expect, test } from "vitest";
import { DiscoveryService } from "../../../src/infra/kube/DiscoveryService";
import { KubeTransport } from "../../../src/infra/kube/KubeTransport";

class FakeTransport extends KubeTransport {
  async streamText(): Promise<void> {}
  calls: string[] = [];
  constructor(private readonly responses: Record<string, unknown>) {
    super();
  }
  async list(): Promise<never> {
    throw new Error("unused");
  }
  async watch(): Promise<never> {
    throw new Error("unused");
  }
  async getJson<T>(context: string, path: string): Promise<T> {
    this.calls.push(`${context}${path}`);
    const r = this.responses[path];
    if (r === undefined) throw Object.assign(new Error("not found"), { status: 404 });
    return r as T;
  }
}

const responses = {
  "/api/v1": {
    resources: [
      { name: "pods", kind: "Pod", namespaced: true, verbs: ["list", "watch"] },
      { name: "pods/log", kind: "Pod", namespaced: true, verbs: ["get"] },
      { name: "namespaces", kind: "Namespace", namespaced: false, verbs: ["list", "watch"] },
    ],
  },
  "/apis": {
    groups: [
      {
        name: "gateway.networking.k8s.io",
        versions: [
          { groupVersion: "gateway.networking.k8s.io/v1", version: "v1" },
          { groupVersion: "gateway.networking.k8s.io/v1alpha2", version: "v1alpha2" },
        ],
        preferredVersion: { groupVersion: "gateway.networking.k8s.io/v1", version: "v1" },
      },
      {
        name: "apps",
        versions: [{ groupVersion: "apps/v1", version: "v1" }],
        preferredVersion: { groupVersion: "apps/v1", version: "v1" },
      },
    ],
  },
  "/apis/gateway.networking.k8s.io/v1": {
    resources: [
      { name: "gateways", kind: "Gateway", namespaced: true, verbs: ["list", "watch"] },
      { name: "httproutes", kind: "HTTPRoute", namespaced: true, verbs: ["list", "watch"] },
    ],
  },
  "/apis/gateway.networking.k8s.io/v1alpha2": {
    resources: [
      { name: "tcproutes", kind: "TCPRoute", namespaced: true, verbs: ["list", "watch"] },
      { name: "httproutes", kind: "HTTPRoute", namespaced: true, verbs: ["list", "watch"] },
    ],
  },
  "/apis/apps/v1": {
    resources: [{ name: "deployments", kind: "Deployment", namespaced: true, verbs: ["list", "watch"] }],
  },
};

describe("DiscoveryService", () => {
  test("resolves core kinds, skipping subresources", async () => {
    const d = new DiscoveryService(new FakeTransport(responses));
    const pod = await d.resolve("dev", { group: "", kind: "Pod" });
    expect(pod).toMatchObject({ group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true });
    expect((await d.resolve("dev", { group: "", kind: "Namespace" }))?.namespaced).toBe(false);
  });

  test("prefers the preferred version and falls back to older versions", async () => {
    const d = new DiscoveryService(new FakeTransport(responses));
    expect((await d.resolve("dev", { group: "gateway.networking.k8s.io", kind: "HTTPRoute" }))?.version).toBe("v1");
    expect((await d.resolve("dev", { group: "gateway.networking.k8s.io", kind: "TCPRoute" }))?.version).toBe(
      "v1alpha2",
    );
  });

  test("unknown group or kind resolves to undefined", async () => {
    const d = new DiscoveryService(new FakeTransport(responses));
    expect(await d.resolve("dev", { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" })).toBeUndefined();
    expect(await d.resolve("dev", { group: "apps", kind: "Nope" })).toBeUndefined();
  });

  test("caches per context and invalidates", async () => {
    const t = new FakeTransport(responses);
    const d = new DiscoveryService(t);
    await d.resolve("dev", { group: "apps", kind: "Deployment" });
    await d.resolve("dev", { group: "apps", kind: "Deployment" });
    expect(t.calls.filter((c) => c === "dev/apis/apps/v1")).toHaveLength(1);
    await d.resolve("prod", { group: "apps", kind: "Deployment" });
    expect(t.calls.filter((c) => c.endsWith("/apis/apps/v1"))).toHaveLength(2);
    d.invalidate("dev");
    await d.resolve("dev", { group: "apps", kind: "Deployment" });
    expect(t.calls.filter((c) => c === "dev/apis/apps/v1")).toHaveLength(2);
  });

  test("groups and all kinds", async () => {
    const d = new DiscoveryService(new FakeTransport(responses));
    expect(await d.hasGroups("dev", ["apps", "gateway.networking.k8s.io"])).toBe(true);
    expect(await d.hasGroups("dev", ["cert-manager.io"])).toBe(false);
    expect(await d.hasGroups("dev", [])).toBe(true);
    const all = await d.listKinds("dev");
    expect(all.map((k) => k.key).sort()).toEqual([
      "/Namespace",
      "/Pod",
      "apps/Deployment",
      "gateway.networking.k8s.io/Gateway",
      "gateway.networking.k8s.io/HTTPRoute",
    ]);
  });

  test("explicit version is honoured", async () => {
    const d = new DiscoveryService(new FakeTransport(responses));
    expect(
      (await d.resolve("dev", { group: "gateway.networking.k8s.io", kind: "HTTPRoute", version: "v1alpha2" }))?.version,
    ).toBe("v1alpha2");
  });
});
