import { injectable } from "@needle-di/core";
import * as k8s from "vscode-kubernetes-tools-api";
import type { ConfigurationV1_1 } from "vscode-kubernetes-tools-api/js/configuration/v1_1";

export class KubernetesApiUnavailableError extends Error {
  constructor(
    readonly api: string,
    readonly reason: "version-unknown" | "version-removed" | "extension-not-available",
  ) {
    super(`Kubernetes extension API '${api}' is unavailable (${reason})`);
    this.name = "KubernetesApiUnavailableError";
  }
}

/** Single entry point for the Microsoft Kubernetes extension API; other classes need not handle `available`/`reason`. */
@injectable()
export class KubernetesExtensionGateway {
  async configuration(): Promise<ConfigurationV1_1> {
    return this.unwrap(await k8s.extension.configuration.v1_1, "configuration");
  }

  async kubectl(): Promise<k8s.KubectlV1> {
    return this.unwrap(await k8s.extension.kubectl.v1, "kubectl");
  }

  async clusterExplorer(): Promise<k8s.ClusterExplorerV1_1> {
    return this.unwrap(await k8s.extension.clusterExplorer.v1_1, "clusterExplorer");
  }

  private unwrap<T>(api: k8s.API<T>, name: string): T {
    if (api.available) return api.api;
    throw new KubernetesApiUnavailableError(name, api.reason);
  }
}
