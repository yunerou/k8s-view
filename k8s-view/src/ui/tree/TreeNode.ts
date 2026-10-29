import type { KubeResource } from "../../core/resource/KubeResource";
import type { ChildItem } from "../../core/view/RelationResolver";
import type { ChildDefinition, SectionDefinition } from "../../core/view/ViewDefinition";
import type { PortForwardInfo } from "../portForward";

interface Base {
  /** Unique key, stable across refreshes (TreeItem.id). */
  readonly key: string;
  readonly viewId: string;
}

export type NodeDefinition = SectionDefinition | ChildDefinition;

export type TreeNode =
  | (Base & { readonly type: "section"; readonly sectionId: string })
  | (Base & {
      readonly type: "group";
      readonly sectionId: string;
      readonly group: string;
      readonly count: number;
      readonly errors: number;
    })
  | (Base & {
      readonly type: "resource";
      readonly resource: KubeResource;
      readonly definition: NodeDefinition;
      /** Node child relations (section.children or child.children). */
      readonly children: readonly ChildDefinition[];
      readonly sectionId: string;
    })
  | (Base & {
      readonly type: "folder";
      readonly parent: KubeResource;
      readonly child: ChildDefinition;
      readonly count: number;
      readonly sectionId: string;
    })
  | (Base & { readonly type: "field"; readonly item: Extract<ChildItem, { type: "field" }> })
  | (Base & { readonly type: "missing"; readonly item: Extract<ChildItem, { type: "missing" }> })
  | (Base & { readonly type: "message"; readonly text: string; readonly icon: string; readonly tooltip?: string })
  /** "Port-forwards" entry at the top of views with `portForwards: true`. */
  | (Base & { readonly type: "portForwards" })
  | (Base & { readonly type: "portForward"; readonly info: PortForwardInfo });

export const RESOURCE_CONTEXT_PREFIX = "k8sview.resource:";
export const FIELD_CONTEXT_PREFIX = "k8sview.field:";
/** contextValue suffix for Pod container fields: `k8sview.field:/Pod:container`. */
export const CONTAINER_SUFFIX = ":container";
export const PORT_FORWARD_CONTEXT = "k8sview.portForward";
