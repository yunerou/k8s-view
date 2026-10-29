import { inject, injectable } from "@needle-di/core";
import { type LogRequest, LogSource } from "../../app/ports/LogSource";
import { KubeTransport } from "./KubeTransport";

/** Stream logs via `GET /api/v1/namespaces/<ns>/pods/<pod>/log` using context authentication (no kubectl required). */
@injectable()
export class KubeLogSource extends LogSource {
  constructor(private readonly transport = inject(KubeTransport)) {
    super();
  }

  async stream(
    context: string,
    request: LogRequest,
    onData: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const path = `/api/v1/namespaces/${encodeURIComponent(request.namespace)}/pods/${encodeURIComponent(request.pod)}/log`;
    const query: Record<string, string> = { container: request.container };
    if (request.follow) query["follow"] = "true";
    if (request.timestamps) query["timestamps"] = "true";
    if (request.sinceTime) query["sinceTime"] = request.sinceTime;
    else if (request.tailLines !== undefined) query["tailLines"] = String(request.tailLines);
    try {
      await this.transport.streamText(context, path, query, onData, signal);
    } catch (e) {
      if (signal.aborted) return;
      throw e;
    }
  }
}
