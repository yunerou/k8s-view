import { inject, injectable } from "@needle-di/core";
import type * as vscode from "vscode";
import { type BatchOutcome, BatchRunner } from "../../app/ports/Runners";
import type { RenderedRun } from "../../core/command/CommandTemplate";
import type { KubeResource } from "../../core/resource/KubeResource";
import { KubeHttp } from "./KubeHttp";

const CONCURRENCY = 4;
type BatchRun = Extract<RenderedRun, { type: "batch" }>;

/** Kubernetes writes are per object. Keep exact UIDs, reuse authenticated transport and bound concurrency. */
@injectable()
export class KubeBatchRunner extends BatchRunner {
  constructor(private readonly http = inject(KubeHttp)) {
    super();
  }

  async run(
    context: string,
    run: BatchRun,
    targets: readonly KubeResource[],
    token: vscode.CancellationToken,
  ): Promise<BatchOutcome> {
    const resources = [...new Map(targets.map((r) => [r.uid, r])).values()];
    for (const resource of resources) validate(run, resource);
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    let next = 0;
    let succeeded = 0;
    const failures: string[] = [];
    const restartedAt = new Date().toISOString();
    const worker = async () => {
      while (!controller.signal.aborted && next < resources.length) {
        const resource = resources[next++]!;
        try {
          const { path, method, body } = mutation(run, resource, restartedAt);
          await this.http.mutate(context, path, method, body, controller.signal);
          succeeded++;
        } catch (e) {
          if (!controller.signal.aborted)
            failures.push(
              `${resource.kind.kind} ${resource.namespace ? `${resource.namespace}/` : ""}${resource.name}: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, resources.length) }, worker));
      return { succeeded, failures, cancelled: controller.signal.aborted };
    } finally {
      cancellation.dispose();
    }
  }
}

function validate(run: BatchRun, r: KubeResource): void {
  const supported: Record<BatchRun["operation"], readonly string[]> = {
    copyNames: [],
    delete: ["/Pod", "batch/Job"],
    restart: ["apps/Deployment", "apps/StatefulSet", "apps/DaemonSet"],
    scale: ["apps/Deployment", "apps/StatefulSet", "apps/ReplicaSet", "/ReplicationController"],
    suspend: ["batch/CronJob", "batch/Job"],
    resume: ["batch/CronJob", "batch/Job"],
    trigger: ["batch/CronJob"],
    cordon: ["/Node"],
    uncordon: ["/Node"],
  };
  if (!supported[run.operation].includes(r.kind.key))
    throw new Error(`${run.operation} is not supported for ${r.kind.kind}`);
  if (!r.uid || (r.kind.namespaced && !r.namespace)) throw new Error(`Missing resource identity for ${r.name}`);
  if (
    run.operation === "scale" &&
    (!/^\d+$/.test(run.replicas ?? "") ||
      !Number.isSafeInteger(Number(run.replicas)) ||
      Number(run.replicas) > 2_147_483_647)
  )
    throw new Error("Replicas must be an integer between 0 and 2147483647");
  if (
    run.operation === "trigger" &&
    !(r.object["spec"] as { jobTemplate?: { spec?: unknown } } | undefined)?.jobTemplate?.spec
  )
    throw new Error(`CronJob ${r.name} has no job template`);
}

function mutation(
  run: BatchRun,
  r: KubeResource,
  restartedAt: string,
): { path: string; method: "DELETE" | "PATCH" | "POST"; body: unknown } {
  const path = r.kind.itemPath(r.namespace, r.name);
  if (run.operation === "delete")
    return {
      path,
      method: "DELETE",
      body: { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: r.uid }, propagationPolicy: "Background" },
    };
  if (run.operation === "trigger") {
    const template = (
      r.object["spec"] as {
        jobTemplate: { metadata?: { labels?: unknown; annotations?: Record<string, string> }; spec: unknown };
      }
    ).jobTemplate;
    return {
      path: `/apis/batch/v1/namespaces/${encodeURIComponent(r.namespace!)}/jobs`,
      method: "POST",
      body: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          generateName: `${r.name.slice(0, 44)}-manual-`,
          namespace: r.namespace,
          labels: template.metadata?.labels ?? {},
          annotations: { ...template.metadata?.annotations, "cronjob.kubernetes.io/instantiate": "manual" },
          ownerReferences: [
            {
              apiVersion: r.kind.apiVersion,
              kind: "CronJob",
              name: r.name,
              uid: r.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        },
        spec: template.spec,
      },
    };
  }
  const metadata = {
    uid: r.uid,
    ...(r.object.metadata.resourceVersion ? { resourceVersion: r.object.metadata.resourceVersion } : {}),
  };
  let spec: unknown;
  switch (run.operation) {
    case "restart":
      spec = { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } } } };
      break;
    case "scale":
      spec = { replicas: Number(run.replicas) };
      break;
    case "suspend":
    case "resume":
      spec = { suspend: run.operation === "suspend" };
      break;
    case "cordon":
    case "uncordon":
      spec = { unschedulable: run.operation === "cordon" };
      break;
    default:
      throw new Error(`Unsupported batch operation: ${run.operation}`);
  }
  return { path: run.operation === "scale" ? `${path}/scale` : path, method: "PATCH", body: { metadata, spec } };
}
