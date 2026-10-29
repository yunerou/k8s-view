import type { KubeResource } from "../resource/KubeResource";
import type { TemplateContext } from "./ExpressionEngine";

/** Variables extracted from resources; `label`/`annotation` take parameters: `${label:app}`. */
export const RESOURCE_VARIABLES = [
  "name",
  "namespace",
  "kind",
  "kindLower",
  "group",
  "apiVersion",
  "plural",
  "uid",
  "label",
  "annotation",
] as const;

/** Variables supplied by the executor when running commands. */
export const COMMAND_VARIABLES = [
  "context",
  "cluster",
  "user",
  "kubeconfig",
  "timestamp",
  "workspaceFolder",
  "input",
  "namespaceFlag",
] as const;

/** Additional variables for `field` relation elements. */
export const FIELD_VARIABLES = ["key", "index"] as const;

export function resourceVariable(r: KubeResource, name: string, arg: string | undefined): string | undefined {
  switch (name) {
    case "name":
      return r.name;
    case "namespace":
      return r.namespace ?? "";
    case "kind":
      return r.kind.kind;
    case "kindLower":
      return r.kind.kind.toLowerCase();
    case "group":
      return r.kind.group;
    case "apiVersion":
      return r.kind.apiVersion;
    case "plural":
      return r.kind.plural;
    case "uid":
      return r.uid;
    case "label":
      return arg === undefined ? undefined : r.labels[arg];
    case "annotation":
      return arg === undefined ? undefined : r.annotations[arg];
    default:
      return undefined;
  }
}

export function resourceContext(
  r: KubeResource,
  extra?: (name: string, arg?: string) => string | undefined,
): TemplateContext {
  return {
    root: r.object,
    variable: (name, arg) => extra?.(name, arg) ?? resourceVariable(r, name, arg),
  };
}
