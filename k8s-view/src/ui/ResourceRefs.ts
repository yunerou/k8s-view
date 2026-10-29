import type { ClusterContext } from "../core/context/ClusterContext";

/** Resource references used in internal commands and document URIs (`k8sview:`). */
export interface ResourceRefArg {
  readonly context: string;
  readonly group: string;
  readonly kind: string;
  readonly namespace?: string | undefined;
  readonly name: string;
}

export function isRefArg(v: unknown): v is ResourceRefArg {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as ResourceRefArg).name === "string" &&
    typeof (v as ResourceRefArg).kind === "string"
  );
}

const CORE = "_core";
const NONE = "_";

/** `k8sview:/<context>/<group>/<kind>/<namespace>/<name>.yaml` — all components are encoded. */
export function refToPath(ref: ResourceRefArg, ext: string): string {
  const parts = [ref.context, ref.group || CORE, ref.kind, ref.namespace || NONE, `${ref.name}${ext}`];
  return `/${parts.map(encodeURIComponent).join("/")}`;
}

export function pathToRef(path: string, ext: string): ResourceRefArg | undefined {
  const parts = path.replace(/^\//, "").split("/").map(decodeURIComponent);
  if (parts.length !== 5) return undefined;
  const [context, group, kind, namespace, file] = parts as [string, string, string, string, string];
  return {
    context,
    group: group === CORE ? "" : group,
    kind,
    namespace: namespace === NONE ? undefined : namespace,
    name: file.endsWith(ext) ? file.slice(0, -ext.length) : file,
  };
}

export function sameContext(ctx: ClusterContext | undefined, name: string): boolean {
  return ctx?.name === name;
}
