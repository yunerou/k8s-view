import { inject, injectable } from "@needle-di/core";
import { KubectlRunner } from "../../app/ports/Runners";
import { KubernetesExtensionGateway } from "../ms-kubernetes/KubernetesExtensionGateway";

/** `kubectl` type: use the exact kubectl binary configured in the MS extension. */
@injectable()
export class MsKubectlRunner extends KubectlRunner {
  constructor(private readonly gateway = inject(KubernetesExtensionGateway)) {
    super();
  }

  async invoke(commandLine: string): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
    const kubectl = await this.gateway.kubectl();
    return kubectl.invokeCommand(commandLine);
  }
}
