// Views and lookup shared by the ParentIndex and ScopeResolver tests.
import { ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import type { KubeResource } from "../../../src/core/resource/KubeResource";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import type { ResourceLookup } from "../../../src/core/view/RelationResolver";
import { compileView } from "../../../src/core/view/ViewDefinition";

const engine = new ExpressionEngine("safe");
export const nodeKind = new ResourceKind("", "v1", "Node", "nodes", false);
export const eventKind = new ResourceKind("", "v1", "Event", "events", true);
const view = (config: unknown) => compileView(ViewSchema.parse(config), engine).view;

export const testViews = [
  view({
    id: "workload",
    title: "Workload",
    sections: [
      {
        id: "deployments",
        title: "Deployments",
        resources: [{ group: "apps", kind: "Deployment" }],
        children: [
          {
            id: "rs",
            relation: { type: "ownerRef", group: "apps", kind: "ReplicaSet" },
            children: [{ id: "pods", relation: { type: "ownerRef", kind: "Pod" } }],
          },
        ],
      },
    ],
  }),
  view({
    id: "node",
    title: "Node",
    sections: [
      {
        id: "nodes",
        title: "Nodes",
        resources: [{ kind: "Node" }],
        children: [
          {
            id: "pods",
            relation: {
              type: "reverseFieldRef",
              group: "",
              kind: "Pod",
              items: "$.spec.nodeName",
              match: { name: "${name}" },
              allNamespaces: true,
            },
          },
        ],
      },
    ],
  }),
  view({
    id: "service",
    title: "Service",
    sections: [
      {
        id: "services",
        title: "Services",
        resources: [{ kind: "Service" }],
        children: [{ id: "pods", relation: { type: "labelSelector", kind: "Pod", selector: "$.spec.selector" } }],
      },
      {
        id: "httproutes",
        title: "HTTPRoutes",
        resources: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute" }],
        children: [
          {
            id: "backends",
            relation: {
              type: "fieldRef",
              items: "$.spec.rules[*].backendRefs[*]",
              group: { path: "$.group", default: "" },
              kind: { path: "$.kind", default: "Service" },
              namespace: "$.namespace",
            },
          },
        ],
      },
    ],
  }),
  view({
    id: "event",
    title: "Events",
    sections: [
      {
        id: "events",
        title: "Events",
        resources: [{ kind: "Event" }],
        children: [
          {
            id: "object",
            relation: {
              type: "fieldRef",
              items: "$.involvedObject",
              group: { path: "$.apiVersion", default: "" },
              kind: { path: "$.kind", default: "Pod" },
              namespace: "$.namespace",
            },
          },
        ],
      },
    ],
  }),
];

export function lookupOf(items: KubeResource[]): ResourceLookup {
  return {
    list: (group, kind, namespace) =>
      items.filter(
        (r) =>
          r.kind.group === group &&
          r.kind.kind === kind &&
          (namespace === undefined || !r.kind.namespaced || r.namespace === namespace),
      ),
    byOwner: (group, kind, uid) =>
      items.filter((r) => r.kind.group === group && r.kind.kind === kind && r.ownerUids.includes(uid)),
  };
}
