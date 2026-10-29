/**
 * Browser URLs for HTTPRoute (Gateway API) and Ingress: host × path, scheme based on TLS.
 * Wildcard hosts and regex paths cannot be opened, so they are skipped / replaced with `/`.
 */

type Obj = Record<string, unknown>;

const GATEWAY_GROUP = "gateway.networking.k8s.io";

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** `*.example.com` matches `a.example.com` (one label), following Gateway API hostname rules. */
export function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === host;
  const suffix = pattern.slice(1);
  return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".");
}

const isWildcard = (host: string) => host.includes("*");
const REGEX_CHARS = /[()[\]*+?^$|\\{}]/;

function cleanPath(path: string | undefined): string {
  if (!path || REGEX_CHARS.test(path)) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function url(scheme: "http" | "https", host: string, port: number | undefined, path: string): string {
  const standard = (scheme === "https" && port === 443) || (scheme === "http" && port === 80) || port === undefined;
  return `${scheme}://${host}${standard ? "" : `:${port}`}${path}`;
}

interface Listener {
  readonly protocol: string;
  readonly hostname: string | undefined;
  readonly port: number | undefined;
}

/** Parent Gateway HTTP/HTTPS listeners (filtered by parentRef `sectionName`/`port`). */
function parentListeners(route: Obj, gateways: readonly Obj[]): Listener[] {
  const routeNs = str(obj(route["metadata"])["namespace"]);
  const out: Listener[] = [];
  for (const ref of arr(obj(route["spec"])["parentRefs"])) {
    if ((str(ref["kind"]) ?? "Gateway") !== "Gateway" || (str(ref["group"]) ?? GATEWAY_GROUP) !== GATEWAY_GROUP)
      continue;
    const ns = str(ref["namespace"]) ?? routeNs;
    const gw = gateways.find((g) => {
      const m = obj(g["metadata"]);
      return m["name"] === ref["name"] && (ns === undefined || m["namespace"] === ns);
    });
    if (!gw) continue;
    for (const l of arr(obj(gw["spec"])["listeners"])) {
      const protocol = str(l["protocol"]) ?? "";
      if (protocol !== "HTTP" && protocol !== "HTTPS") continue;
      if (ref["sectionName"] !== undefined && l["name"] !== ref["sectionName"]) continue;
      if (typeof ref["port"] === "number" && l["port"] !== ref["port"]) continue;
      out.push({
        protocol,
        hostname: str(l["hostname"]),
        port: typeof l["port"] === "number" ? l["port"] : undefined,
      });
    }
  }
  return out;
}

/**
 * HTTPRoute URLs. `gateways`: resolved parent Gateways (for HTTPS/port and listener hostnames when the route omits
 * `hostnames`); default to `https` when a Gateway is missing.
 */
export function httpRouteUrls(route: Obj, gateways: readonly Obj[]): string[] {
  const spec = obj(route["spec"]);
  const listeners = parentListeners(route, gateways);
  let hosts = ((spec["hostnames"] as unknown[]) ?? []).filter((h): h is string => !!str(h) && !isWildcard(h as string));
  if (hosts.length === 0) hosts = listeners.flatMap((l) => (l.hostname && !isWildcard(l.hostname) ? [l.hostname] : []));
  if (hosts.length === 0) {
    hosts = gateways.flatMap((g) =>
      arr(obj(g["status"])["addresses"]).flatMap((a) => (str(a["value"]) ? [a["value"] as string] : [])),
    );
  }
  const paths = new Set<string>();
  for (const rule of arr(spec["rules"])) {
    for (const match of arr(rule["matches"])) {
      const p = obj(match["path"]);
      paths.add(p["type"] === "RegularExpression" ? "/" : cleanPath(str(p["value"])));
    }
  }
  if (paths.size === 0) paths.add("/");

  const out = new Set<string>();
  for (const host of hosts) {
    const forHost = listeners.filter((l) => !l.hostname || hostMatches(l.hostname, host));
    const candidates = forHost.length > 0 ? forHost : listeners;
    const https = candidates.find((l) => l.protocol === "HTTPS");
    const http = candidates.find((l) => l.protocol === "HTTP");
    const [scheme, port] = https
      ? (["https", https.port] as const)
      : http
        ? (["http", http.port] as const)
        : ["https" as const, undefined];
    for (const path of paths) out.add(url(scheme, host, port, path));
  }
  return [...out];
}

/** Ingress URLs: hosts listed in `spec.tls[].hosts` use HTTPS; rules without a host use the load balancer address. */
export function ingressUrls(ingress: Obj): string[] {
  const spec = obj(ingress["spec"]);
  const tlsHosts = arr(spec["tls"]).flatMap((t) =>
    ((t["hosts"] as unknown[]) ?? []).filter((h): h is string => !!str(h)),
  );
  const lb = arr(obj(obj(ingress["status"])["loadBalancer"])["ingress"]).flatMap((i) => {
    const v = str(i["hostname"]) ?? str(i["ip"]);
    return v ? [v] : [];
  });
  const out = new Set<string>();
  for (const rule of arr(spec["rules"])) {
    const ruleHost = str(rule["host"]);
    if (ruleHost && isWildcard(ruleHost)) continue;
    const hosts = ruleHost ? [ruleHost] : lb;
    const paths = arr(obj(rule["http"])["paths"]).map((p) => cleanPath(str(p["path"])));
    for (const host of hosts) {
      const secure = tlsHosts.some((t) => hostMatches(t, host));
      for (const path of paths.length > 0 ? paths : ["/"])
        out.add(url(secure ? "https" : "http", host, undefined, path));
    }
  }
  if (out.size === 0 && spec["defaultBackend"]) for (const host of lb) out.add(`http://${host}/`);
  return [...out];
}

/** Parent Gateways referenced by HTTPRoute (to read listeners): name and namespace. */
export function parentGateways(route: Obj): { name: string; namespace: string | undefined }[] {
  const routeNs = str(obj(route["metadata"])["namespace"]);
  return arr(obj(route["spec"])["parentRefs"]).flatMap((ref) =>
    (str(ref["kind"]) ?? "Gateway") === "Gateway" &&
    (str(ref["group"]) ?? GATEWAY_GROUP) === GATEWAY_GROUP &&
    str(ref["name"])
      ? [{ name: ref["name"] as string, namespace: str(ref["namespace"]) ?? routeNs }]
      : [],
  );
}
