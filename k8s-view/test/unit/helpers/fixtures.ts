import type { KubeObject } from "../../../src/core/resource/KubeResource";
import { KubeResource } from "../../../src/core/resource/KubeResource";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";

export const kinds = {
  pod: new ResourceKind("", "v1", "Pod", "pods", true),
  service: new ResourceKind("", "v1", "Service", "services", true),
  configMap: new ResourceKind("", "v1", "ConfigMap", "configmaps", true),
  secret: new ResourceKind("", "v1", "Secret", "secrets", true),
  serviceAccount: new ResourceKind("", "v1", "ServiceAccount", "serviceaccounts", true),
  namespace: new ResourceKind("", "v1", "Namespace", "namespaces", false),
  deployment: new ResourceKind("apps", "v1", "Deployment", "deployments", true),
  replicaSet: new ResourceKind("apps", "v1", "ReplicaSet", "replicasets", true),
  statefulSet: new ResourceKind("apps", "v1", "StatefulSet", "statefulsets", true),
  daemonSet: new ResourceKind("apps", "v1", "DaemonSet", "daemonsets", true),
  job: new ResourceKind("batch", "v1", "Job", "jobs", true),
  cronJob: new ResourceKind("batch", "v1", "CronJob", "cronjobs", true),
  roleBinding: new ResourceKind("rbac.authorization.k8s.io", "v1", "RoleBinding", "rolebindings", true),
  clusterRoleBinding: new ResourceKind(
    "rbac.authorization.k8s.io",
    "v1",
    "ClusterRoleBinding",
    "clusterrolebindings",
    false,
  ),
  role: new ResourceKind("rbac.authorization.k8s.io", "v1", "Role", "roles", true),
  clusterRole: new ResourceKind("rbac.authorization.k8s.io", "v1", "ClusterRole", "clusterroles", false),
  kustomization: new ResourceKind("kustomize.toolkit.fluxcd.io", "v1", "Kustomization", "kustomizations", true),
  gitRepository: new ResourceKind("source.toolkit.fluxcd.io", "v1", "GitRepository", "gitrepositories", true),
  httpRoute: new ResourceKind("gateway.networking.k8s.io", "v1", "HTTPRoute", "httproutes", true),
} as const;

let counter = 0;

export function res(
  kind: ResourceKind,
  name: string,
  extra: Partial<KubeObject> & Record<string, unknown> = {},
  namespace?: string,
): KubeResource {
  const { metadata, ...rest } = extra;
  const ns = kind.namespaced ? (namespace ?? "default") : undefined;
  return new KubeResource(kind, {
    apiVersion: kind.apiVersion,
    kind: kind.kind,
    ...rest,
    metadata: {
      name,
      uid: `${kind.kind.toLowerCase()}-${name}-${++counter}`,
      creationTimestamp: "2026-10-20T00:00:00Z",
      ...(ns ? { namespace: ns } : {}),
      ...metadata,
    },
  });
}
