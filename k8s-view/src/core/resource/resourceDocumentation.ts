import { ResourceKind } from "./ResourceKind";

// Curated concept guides, independent of the object's API version. Keep explicit
// URLs here: Kubernetes documentation paths cannot be derived reliably from kind.
const guides = new Map<string, string>([
  ["/Pod", "https://kubernetes.io/docs/concepts/workloads/pods/"],
  ["/Service", "https://kubernetes.io/docs/concepts/services-networking/service/"],
  ["/ConfigMap", "https://kubernetes.io/docs/concepts/configuration/configmap/"],
  ["/Secret", "https://kubernetes.io/docs/concepts/configuration/secret/"],
  ["/Namespace", "https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/"],
  ["/Node", "https://kubernetes.io/docs/concepts/architecture/nodes/"],
  ["/PersistentVolume", "https://kubernetes.io/docs/concepts/storage/persistent-volumes/"],
  ["/PersistentVolumeClaim", "https://kubernetes.io/docs/concepts/storage/persistent-volumes/#persistentvolumeclaims"],
  ["/ServiceAccount", "https://kubernetes.io/docs/concepts/security/service-accounts/"],
  ["/ResourceQuota", "https://kubernetes.io/docs/concepts/policy/resource-quotas/"],
  ["/LimitRange", "https://kubernetes.io/docs/concepts/policy/limit-range/"],
  ["apps/Deployment", "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/"],
  ["apps/StatefulSet", "https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/"],
  ["apps/DaemonSet", "https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/"],
  ["apps/ReplicaSet", "https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/"],
  ["batch/Job", "https://kubernetes.io/docs/concepts/workloads/controllers/job/"],
  ["batch/CronJob", "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/"],
  ["networking.k8s.io/Ingress", "https://kubernetes.io/docs/concepts/services-networking/ingress/"],
  ["networking.k8s.io/IngressClass", "https://kubernetes.io/docs/concepts/services-networking/ingress/#ingress-class"],
  ["networking.k8s.io/NetworkPolicy", "https://kubernetes.io/docs/concepts/services-networking/network-policies/"],
  ["storage.k8s.io/StorageClass", "https://kubernetes.io/docs/concepts/storage/storage-classes/"],
  [
    "autoscaling/HorizontalPodAutoscaler",
    "https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/",
  ],
  [
    "policy/PodDisruptionBudget",
    "https://kubernetes.io/docs/concepts/workloads/pods/disruptions/#pod-disruption-budgets",
  ],
  [
    "rbac.authorization.k8s.io/Role",
    "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#role-and-clusterrole",
  ],
  [
    "rbac.authorization.k8s.io/ClusterRole",
    "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#role-and-clusterrole",
  ],
  [
    "rbac.authorization.k8s.io/RoleBinding",
    "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding",
  ],
  [
    "rbac.authorization.k8s.io/ClusterRoleBinding",
    "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding",
  ],
  [
    "apiextensions.k8s.io/CustomResourceDefinition",
    "https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/",
  ],
]);

/** Unknown kinds (including custom resources) intentionally have no guessed URL. */
export function resourceDocumentation(kind: { readonly group: string; readonly kind: string }): string | undefined {
  return guides.get(ResourceKind.keyOf(kind.group, kind.kind));
}
