import { describe, expect, test } from "vitest";
import { formatAge, formatQuantity } from "../../../src/core/resource/format";
import { KubeResource, normalizeObject } from "../../../src/core/resource/KubeResource";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";

const deployKind = new ResourceKind("apps", "v1", "Deployment", "deployments", true);
const podKind = new ResourceKind("", "v1", "Pod", "pods", true);
const nsKind = new ResourceKind("", "v1", "Namespace", "namespaces", false);

describe("ResourceKind", () => {
  test("key, apiVersion and paths", () => {
    expect(deployKind.key).toBe("apps/Deployment");
    expect(podKind.key).toBe("/Pod");
    expect(deployKind.apiVersion).toBe("apps/v1");
    expect(podKind.apiVersion).toBe("v1");
    expect(deployKind.listPath("team-a")).toBe("/apis/apps/v1/namespaces/team-a/deployments");
    expect(deployKind.listPath(undefined)).toBe("/apis/apps/v1/deployments");
    expect(podKind.itemPath("ns", "p-1")).toBe("/api/v1/namespaces/ns/pods/p-1");
    expect(nsKind.listPath("ignored")).toBe("/api/v1/namespaces");
  });

  test("parses apiVersion", () => {
    expect(ResourceKind.splitApiVersion("apps/v1")).toEqual({ group: "apps", version: "v1" });
    expect(ResourceKind.splitApiVersion("v1")).toEqual({ group: "", version: "v1" });
  });
});

describe("KubeResource", () => {
  const raw = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "web-1",
      namespace: "team-a",
      uid: "u1",
      labels: { app: "web" },
      creationTimestamp: "2026-10-20T00:00:00Z",
      ownerReferences: [{ uid: "rs1", kind: "ReplicaSet", name: "web", apiVersion: "apps/v1" }],
    },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  };

  test("exposes metadata helpers", () => {
    const r = new KubeResource(podKind, raw);
    expect(r.uid).toBe("u1");
    expect(r.name).toBe("web-1");
    expect(r.namespace).toBe("team-a");
    expect(r.ownerUids).toEqual(["rs1"]);
    expect(r.owners[0]!.kind).toBe("ReplicaSet");
    expect(r.labels).toEqual({ app: "web" });
    expect(r.condition("Ready")?.status).toBe("True");
    expect(r.ref).toEqual({ group: "", version: "v1", kind: "Pod", name: "web-1", namespace: "team-a" });
    expect(r.ageMs(Date.parse("2026-10-22T00:00:00Z"))).toBe(2 * 86_400_000);
  });

  test("normalizeObject drops managedFields", () => {
    const o = normalizeObject(podKind, { ...raw, metadata: { ...raw.metadata, managedFields: [{}] } });
    expect(o.metadata["managedFields"]).toBeUndefined();
  });

  test("normalizeObject masks Secret data and last-applied annotation", () => {
    const secretKind = new ResourceKind("", "v1", "Secret", "secrets", true);
    const o = normalizeObject(secretKind, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "s",
        uid: "s1",
        annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"data":{"pw":"c2VjcmV0"}}', keep: "y" },
      },
      data: { pw: "c2VjcmV0", empty: "" },
      stringData: { other: "plain" },
    });
    expect(o["data"]).toEqual({ pw: "<6 bytes>", empty: "<0 bytes>" });
    expect(o["stringData"]).toBeUndefined();
    expect((o.metadata as { annotations: Record<string, string> }).annotations).toEqual({ keep: "y" });
  });
});

describe("format", () => {
  const s = 1000;
  test.each([
    [5 * s, "5s"],
    [90 * s, "90s"],
    [5 * 60 * s, "5m"],
    [5 * 3600 * s, "5h"],
    [49 * 3600 * s, "2d"],
    [9 * 86400 * s, "9d"],
    [800 * 86400 * s, "2y"],
    [-5 * s, "0s"],
  ])("formatAge(%i) = %s", (ms, out) => {
    expect(formatAge(ms)).toBe(out);
  });

  test("formatQuantity", () => {
    expect(formatQuantity("1536Mi")).toBe("1.5Gi");
    expect(formatQuantity("500m")).toBe("500m");
    expect(formatQuantity("2048")).toBe("2Ki");
    expect(formatQuantity("abc")).toBe("abc");
  });
});
