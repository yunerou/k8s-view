import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  decodeHelmRelease,
  helmReleaseLocation,
  helmSecretName,
  latestHelmSecret,
} from "../../../src/core/helm/helmRelease";

/** As stored by Helm: base64(gzip(JSON)), then base64-encoded again by the API server in `data`. */
function secretValue(release: object): string {
  const helm = gzipSync(Buffer.from(JSON.stringify(release))).toString("base64");
  return Buffer.from(helm).toString("base64");
}

describe("decodeHelmRelease", () => {
  test("reads user values and chart default values", () => {
    const data = decodeHelmRelease(
      secretValue({
        name: "podinfo",
        namespace: "apps",
        version: 3,
        config: { replicaCount: 2, ingress: { enabled: true } },
        chart: { metadata: { name: "podinfo", version: "6.5.0" }, values: { replicaCount: 1, image: { tag: "" } } },
      }),
    );
    expect(data).toEqual({
      name: "podinfo",
      namespace: "apps",
      revision: 3,
      chartName: "podinfo",
      chartVersion: "6.5.0",
      values: { replicaCount: 2, ingress: { enabled: true } },
      defaultValues: { replicaCount: 1, image: { tag: "" } },
    });
  });

  test("release without user values gives an empty object", () => {
    const data = decodeHelmRelease(secretValue({ name: "x", config: null, chart: { metadata: { name: "x" } } }));
    expect(data.values).toEqual({});
    expect(data.defaultValues).toEqual({});
  });
});

describe("helmReleaseLocation", () => {
  test("prefers status.history[0] of helm-controller v2", () => {
    const hr = {
      metadata: { name: "podinfo", namespace: "flux-system" },
      spec: { targetNamespace: "apps" },
      status: { storageNamespace: "apps", history: [{ name: "apps-podinfo", version: 4 }, { version: 3 }] },
    };
    expect(helmReleaseLocation(hr)).toEqual({ release: "apps-podinfo", storageNamespace: "apps", revision: 4 });
  });

  test("falls back to Flux naming: releaseName, [targetNamespace-]name shortened past 53 chars", () => {
    expect(helmReleaseLocation({ metadata: { name: "web", namespace: "apps" }, spec: {} })).toEqual({
      release: "web",
      storageNamespace: "apps",
      revision: undefined,
    });
    expect(
      helmReleaseLocation({ metadata: { name: "web", namespace: "apps" }, spec: { releaseName: "custom" } }).release,
    ).toBe("custom");
    const long = helmReleaseLocation({
      metadata: { name: "a-very-long-helm-release-name-for-testing", namespace: "flux-system" },
      spec: { targetNamespace: "another-long-namespace" },
    }).release;
    expect(long).toHaveLength(53);
    expect(long.startsWith("another-long-namespace-a-very-long-helm-")).toBe(true);
  });

  test("secret names: exact revision and latest from a listing", () => {
    expect(helmSecretName("web", 7)).toBe("sh.helm.release.v1.web.v7");
    expect(
      latestHelmSecret(
        ["sh.helm.release.v1.web.v2", "sh.helm.release.v1.web.v10", "sh.helm.release.v1.web-api.v12", "other"],
        "web",
      ),
    ).toBe("sh.helm.release.v1.web.v10");
  });
});
