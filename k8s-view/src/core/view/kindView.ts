import { type ViewConfig, ViewSchema } from "../config/schema";
import { metricColumns } from "./metricColumns";

/** "Single resource kind" view ID: one section listing all resources of the user-selected kind. */
export const KIND_VIEW_ID = "kind";

export interface KindViewTarget {
  readonly group: string;
  readonly kind: string;
  /** Plural name from discovery, used as the section title. */
  readonly plural?: string;
}

/** Generated view for any kind (CRDs, rarely used kinds): basic information only — name, namespace, Ready, age. */
export function kindViewConfig(target: KindViewTarget): ViewConfig {
  return ViewSchema.parse({
    id: KIND_VIEW_ID,
    title: `Kind: ${target.kind}`,
    icon: "symbol-class",
    order: 100,
    sections: [
      {
        id: "resources",
        title: target.plural ? `${target.plural}${target.group ? `.${target.group}` : ""}` : target.kind,
        icon: "symbol-class",
        resources: [{ group: target.group, kind: target.kind }],
        columns: [
          { title: "Ready", path: "$.status.conditions[?(@.type=='Ready')].status", render: "status" },
          ...(target.group === "" && ["Pod", "Node"].includes(target.kind) ? metricColumns() : []),
          { title: "Age", path: "$.metadata.creationTimestamp", render: "age" },
        ],
      },
    ],
  });
}
