import type * as vscode from "vscode";

export interface KubeContextInfo {
  readonly name: string;
  readonly cluster: string;
  readonly user: string;
  /** Default namespace declared in kubeconfig. */
  readonly namespace: string | undefined;
}

/** Port: kubeconfig shared with Microsoft's Kubernetes extension; infra binds `KubeConfigProvider`. */
export abstract class KubeConfigSource {
  abstract readonly onDidChange: vscode.Event<void>;
  abstract contexts(): readonly KubeContextInfo[];
  /** `current-context` trong file kubeconfig. */
  abstract currentContext(): string | undefined;
  /** `KUBECONFIG` environment variable value for external commands (may contain multiple files, `a:b`). */
  abstract kubeconfigEnv(): string;
  /** Kubeconfig read errors (invalid file, unsupported WSL, etc.), displayed in the Context panel. */
  abstract loadError(): string | undefined;
}
