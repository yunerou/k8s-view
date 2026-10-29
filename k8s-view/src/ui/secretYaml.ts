import { stringify } from "yaml";
import type { DecodedSecretValue } from "../core/resource/secretData";
import type { ResourceRefArg } from "./ResourceRefs";

/** `stringData`-style YAML (can be pasted back into a manifest); binary keys remain base64 in `data`. */
export function secretYaml(
  ref: ResourceRefArg,
  type: string | undefined,
  values: readonly DecodedSecretValue[],
): string {
  const stringData: Record<string, string> = {};
  const data: Record<string, string> = {};
  for (const v of values) {
    if (v.type === "text") stringData[v.key] = v.text;
    else data[v.key] = v.base64;
  }
  const binary = values.filter((v) => v.type === "binary");
  const header = [
    `# Decoded Secret ${ref.namespace}/${ref.name} — context ${ref.context}`,
    "# Read-only view, not saved to disk. Close it when done; do not paste secrets into chats or tickets.",
    ...binary.map((v) => `# '${v.key}' is binary (${v.type === "binary" ? v.size : 0} bytes): kept base64 in 'data'`),
  ];
  const body = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: ref.name, namespace: ref.namespace },
    ...(type ? { type } : {}),
    ...(values.length === 0 ? { data: {} } : {}),
    ...(Object.keys(stringData).length > 0 ? { stringData } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
  return `${header.join("\n")}\n${stringify(body, { lineWidth: 0 })}`;
}
