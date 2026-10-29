import { inject, injectable } from "@needle-di/core";
import { ClusterApi } from "../../app/ports/ClusterApi";
import { ExecCredentialProvider } from "./ExecCredentialProvider";
import { KubeTransport } from "./KubeTransport";

@injectable()
export class KubeClusterApi extends ClusterApi {
  constructor(
    private readonly transport = inject(KubeTransport),
    private readonly credentials = inject(ExecCredentialProvider),
  ) {
    super();
  }

  async version(context: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const v = await this.transport.getJson<{ gitVersion?: string }>(context, "/version", {}, timeoutMs, signal);
    return v.gitVersion ?? "unknown";
  }

  needsLogin(context: string, reauthenticate?: boolean): boolean {
    return this.credentials.needsLogin(context, reauthenticate);
  }

  login(context: string, signal: AbortSignal, reauthenticate?: boolean): Promise<void> {
    return this.credentials.login(context, signal, reauthenticate);
  }

  async listNamespaces(context: string): Promise<string[]> {
    const list = await this.transport.getJson<{ items?: { metadata: { name: string } }[] }>(
      context,
      "/api/v1/namespaces",
    );
    return (list.items ?? []).map((n) => n.metadata.name);
  }
}
