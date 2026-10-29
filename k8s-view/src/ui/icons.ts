import * as vscode from "vscode";
import type { StatusLevel } from "../core/config/schema";

const LEVEL_COLOR: Record<StatusLevel, string | undefined> = {
  ok: "testing.iconPassed",
  warning: "list.warningForeground",
  error: "list.errorForeground",
  progress: "charts.blue",
  unknown: undefined,
};

const KIND_ICON: Record<string, string> = {
  "/Pod": "symbol-class",
  "apps/Deployment": "rocket",
  "apps/StatefulSet": "database",
  "apps/DaemonSet": "server",
  "apps/ReplicaSet": "copy",
  "batch/Job": "run",
  "batch/CronJob": "watch",
  "/ConfigMap": "symbol-file",
  "/Secret": "lock",
  "/Service": "plug",
  "/ServiceAccount": "account",
  "networking.k8s.io/Ingress": "globe",
  "rbac.authorization.k8s.io/Role": "shield",
  "rbac.authorization.k8s.io/ClusterRole": "shield",
  "rbac.authorization.k8s.io/RoleBinding": "link",
  "rbac.authorization.k8s.io/ClusterRoleBinding": "link",
  "/Node": "server-environment",
  "/PersistentVolumeClaim": "database",
  "/PersistentVolume": "server",
  "storage.k8s.io/StorageClass": "layers",
  "storage.k8s.io/VolumeAttachment": "plug",
  "snapshot.storage.k8s.io/VolumeSnapshot": "device-camera",
  "/Event": "bell",
  "apiextensions.k8s.io/CustomResourceDefinition": "extensions",
  "apiregistration.k8s.io/APIService": "symbol-interface",
  "autoscaling/HorizontalPodAutoscaler": "arrow-both",
  "autoscaling.k8s.io/VerticalPodAutoscaler": "arrow-swap",
  "policy/PodDisruptionBudget": "shield",
  "gateway.networking.k8s.io/Gateway": "radio-tower",
  "gateway.networking.k8s.io/GatewayClass": "symbol-interface",
};

export function levelColor(level: StatusLevel): vscode.ThemeColor | undefined {
  const id = LEVEL_COLOR[level];
  return id ? new vscode.ThemeColor(id) : undefined;
}

/**
 * Kind-specific codicons, colored by status level; `override` (status rule icon/color) takes precedence,
 * e.g. CronJob Pods: gray/green/red dots.
 */
export function resourceIcon(
  kindKey: string,
  level: StatusLevel,
  fallback?: string,
  override?: { readonly icon?: string; readonly color?: string },
): vscode.ThemeIcon {
  const id = override?.icon ?? KIND_ICON[kindKey] ?? fallback ?? "symbol-object";
  const color = override?.color ? new vscode.ThemeColor(override.color) : levelColor(level);
  return color ? new vscode.ThemeIcon(id, color) : new vscode.ThemeIcon(id);
}

export const LEVEL_LABEL: Record<StatusLevel, string> = {
  ok: "OK",
  warning: "Warning",
  error: "Error",
  progress: "In progress",
  unknown: "Unknown",
};
