import type { KubeConfig } from "@kubernetes/client-node";
import type * as vscode from "vscode";

/** Original loaded `KubeConfig` (bound to `KubeConfigProvider`); separated so other infra does not pull in the MS extension API. */
export abstract class KubeConfigAccess {
  abstract readonly onDidChange: vscode.Event<void>;
  /** Do not mutate this object. */
  abstract kubeConfig(): KubeConfig;
}
