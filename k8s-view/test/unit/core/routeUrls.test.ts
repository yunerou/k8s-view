import { describe, expect, test } from "vitest";
import { hostMatches, httpRouteUrls, ingressUrls, parentGateways } from "../../../src/core/resource/routeUrls";

const gateway = (name: string, listeners: object[], addresses: string[] = []) => ({
  metadata: { name, namespace: "infra" },
  spec: { listeners },
  status: { addresses: addresses.map((value) => ({ type: "IPAddress", value })) },
});

const route = (spec: object) => ({ metadata: { name: "web", namespace: "app" }, spec });

describe("httpRouteUrls", () => {
  const gw = gateway("public", [
    { name: "http", protocol: "HTTP", port: 80 },
    { name: "https", protocol: "HTTPS", port: 443, hostname: "*.example.com" },
  ]);

  test("hostnames × path prefixes; https when an HTTPS listener matches the host", () => {
    const r = route({
      parentRefs: [{ name: "public", namespace: "infra" }],
      hostnames: ["web.example.com", "*.example.com"],
      rules: [
        { matches: [{ path: { type: "PathPrefix", value: "/api" } }, { path: { type: "Exact", value: "/health" } }] },
        { matches: [{ path: { type: "RegularExpression", value: "/v[0-9]+" } }] },
      ],
    });
    expect(httpRouteUrls(r, [gw])).toEqual([
      "https://web.example.com/api",
      "https://web.example.com/health",
      "https://web.example.com/",
    ]);
  });

  test("http and non-standard port when only an HTTP listener exists for the host", () => {
    const g = gateway("internal", [{ name: "web", protocol: "HTTP", port: 8080 }]);
    const r = route({ parentRefs: [{ name: "internal", namespace: "infra" }], hostnames: ["web.internal"] });
    expect(httpRouteUrls(r, [g])).toEqual(["http://web.internal:8080/"]);
  });

  test("sectionName selects the listener", () => {
    const r = route({
      parentRefs: [{ name: "public", namespace: "infra", sectionName: "http" }],
      hostnames: ["web.example.com"],
    });
    expect(httpRouteUrls(r, [gw])).toEqual(["http://web.example.com/"]);
  });

  test("without hostnames: listener hostname, then gateway addresses; without gateway: https", () => {
    const named = gateway("g", [{ name: "h", protocol: "HTTPS", port: 443, hostname: "shop.example.com" }]);
    const r = route({ parentRefs: [{ name: "g", namespace: "infra" }] });
    expect(httpRouteUrls(r, [named])).toEqual(["https://shop.example.com/"]);
    const ip = gateway("g", [{ name: "h", protocol: "HTTP", port: 80 }], ["10.0.0.5"]);
    expect(httpRouteUrls(r, [ip])).toEqual(["http://10.0.0.5/"]);
    expect(httpRouteUrls(route({ hostnames: ["a.example.com"] }), [])).toEqual(["https://a.example.com/"]);
  });

  test("parentGateways defaults to the route namespace and skips non-Gateway parents", () => {
    const r = route({
      parentRefs: [{ name: "a" }, { name: "b", namespace: "infra" }, { name: "svc", kind: "Service", group: "" }],
    });
    expect(parentGateways(r)).toEqual([
      { name: "a", namespace: "app" },
      { name: "b", namespace: "infra" },
    ]);
  });
});

describe("ingressUrls", () => {
  test("https for hosts listed in tls, http otherwise; load balancer address for host-less rules", () => {
    const ing = {
      spec: {
        tls: [{ hosts: ["secure.example.com"] }],
        rules: [
          { host: "secure.example.com", http: { paths: [{ path: "/" }, { path: "/admin(/|$)(.*)" }] } },
          { host: "plain.example.com", http: { paths: [{ path: "/docs" }] } },
          { host: "*.example.com" },
          { http: { paths: [{ path: "/x" }] } },
        ],
      },
      status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } },
    };
    expect(ingressUrls(ing)).toEqual([
      "https://secure.example.com/",
      "http://plain.example.com/docs",
      "http://1.2.3.4/x",
    ]);
  });
});

test("hostMatches follows Gateway API wildcard rules (one label)", () => {
  expect(hostMatches("*.example.com", "a.example.com")).toBe(true);
  expect(hostMatches("*.example.com", "a.b.example.com")).toBe(false);
  expect(hostMatches("a.example.com", "a.example.com")).toBe(true);
});
