import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * Read Helm releases from storage Secrets (`sh.helm.release.v1.<release>.v<revision>`, the default Helm and Flux driver):
 * `data.release` = base64(base64(gzip(JSON))). Extract user values (`config`) and chart defaults from it.
 */

type Obj = Record<string, unknown>;

export interface HelmReleaseLocation {
  /** Helm release name (may differ from HelmRelease when using `targetNamespace`/`releaseName`). */
  readonly release: string;
  /** Namespace containing release storage Secrets. */
  readonly storageNamespace: string;
  /** Latest revision from `status`, if available. */
  readonly revision: number | undefined;
}

export interface HelmReleaseData {
  readonly name: string;
  readonly namespace: string | undefined;
  readonly revision: number | undefined;
  readonly chartName: string | undefined;
  readonly chartVersion: string | undefined;
  /** User-supplied install/upgrade values (Flux's spec.values + valuesFrom). */
  readonly values: Obj;
  /** Chart `values.yaml`. */
  readonly defaultValues: Obj;
}

const SECRET_PREFIX = "sh.helm.release.v1.";
const MAX_RELEASE_NAME = 53;

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Like helm-controller's `ShortenName`: names longer than 53 characters = first 40 characters + "-" + 12 hex characters of sha256. */
function shorten(name: string): string {
  if (name.length <= MAX_RELEASE_NAME) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${name.slice(0, 40)}-${hash}`;
}

/** Helm release location for a Flux HelmRelease: prefer `status.history[0]`, then Flux naming rules. */
export function helmReleaseLocation(helmRelease: Obj): HelmReleaseLocation {
  const metadata = obj(helmRelease["metadata"]);
  const spec = obj(helmRelease["spec"]);
  const status = obj(helmRelease["status"]);
  const latest = obj((status["history"] as unknown[] | undefined)?.[0]);
  const name = str(metadata["name"]) ?? "";
  const target = str(spec["targetNamespace"]);
  const release = str(latest["name"]) ?? str(spec["releaseName"]) ?? shorten(target ? `${target}-${name}` : name);
  const storageNamespace =
    str(status["storageNamespace"]) ?? str(spec["storageNamespace"]) ?? str(metadata["namespace"]) ?? "default";
  const revision =
    typeof latest["version"] === "number"
      ? latest["version"]
      : typeof status["lastReleaseRevision"] === "number"
        ? status["lastReleaseRevision"]
        : undefined;
  return { release, storageNamespace, revision };
}

export function helmSecretName(release: string, revision: number): string {
  return `${SECRET_PREFIX}${release}.v${revision}`;
}

/** Latest revision's Secret from a list of Secret names in the namespace. */
export function latestHelmSecret(names: readonly string[], release: string): string | undefined {
  const prefix = `${SECRET_PREFIX}${release}.v`;
  let best: { name: string; revision: number } | undefined;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const revision = Number(name.slice(prefix.length));
    if (Number.isInteger(revision) && (!best || revision > best.revision)) best = { name, revision };
  }
  return best?.name;
}

/** Decode `data.release` (base64 as represented in the API Secret object). */
export function decodeHelmRelease(secretValueBase64: string): HelmReleaseData {
  const inner = Buffer.from(secretValueBase64, "base64").toString("utf8");
  let bytes = Buffer.from(inner, "base64");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const release = JSON.parse(bytes.toString("utf8")) as Obj;
  const chart = obj(release["chart"]);
  const chartMeta = obj(chart["metadata"]);
  return {
    name: str(release["name"]) ?? "",
    namespace: str(release["namespace"]),
    revision: typeof release["version"] === "number" ? release["version"] : undefined,
    chartName: str(chartMeta["name"]),
    chartVersion: str(chartMeta["version"]),
    values: obj(release["config"]),
    defaultValues: obj(chart["values"]),
  };
}
