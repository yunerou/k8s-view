import { describe, expect, test, vi } from "vitest";
import { CancellationTokenSource } from "vscode";
import { KubeBatchRunner } from "../../../src/infra/kube/KubeBatchRunner";
import type { KubeHttp } from "../../../src/infra/kube/KubeHttp";
import { kinds, res } from "../helpers/fixtures";

vi.mock("../../../src/infra/kube/KubeClientFactory", () => ({ KubeClientFactory: class {} }));

function setup(mutate = vi.fn(async (..._args: unknown[]) => {})) {
  return {
    mutate,
    runner: new KubeBatchRunner({ mutate } as unknown as KubeHttp),
    cancellation: new CancellationTokenSource(),
  };
}

const pods = [res(kinds.pod, "a", {}, "team-a"), res(kinds.pod, "b", {}, "team-b")];

describe("KubeBatchRunner", () => {
  test("deletes only selected identities across namespaces, with UID preconditions", async () => {
    const { runner, mutate, cancellation } = setup();
    expect(await runner.run("dev", { type: "batch", operation: "delete" }, pods, cancellation.token)).toEqual({
      succeeded: 2,
      failures: [],
      cancelled: false,
    });
    expect(mutate.mock.calls.map((c) => c.slice(0, 4))).toEqual(
      pods.map((r) => [
        "dev",
        r.kind.itemPath(r.namespace, r.name),
        "DELETE",
        { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: r.uid }, propagationPolicy: "Background" },
      ]),
    );
  });

  test("scale patches preserve object identity and resourceVersion", async () => {
    const { runner, mutate, cancellation } = setup();
    const target = res(
      kinds.deployment,
      "web",
      { metadata: { name: "web", namespace: "team-a", uid: "uid1", resourceVersion: "17" } },
      "team-a",
    );
    await runner.run("prod", { type: "batch", operation: "scale", replicas: "3" }, [target], cancellation.token);
    expect(mutate).toHaveBeenCalledWith(
      "prod",
      `${target.kind.itemPath(target.namespace, target.name)}/scale`,
      "PATCH",
      { metadata: { uid: target.uid, resourceVersion: "17" }, spec: { replicas: 3 } },
      expect.any(AbortSignal),
    );
  });

  test("restart uses the same annotation timestamp for the whole selection", async () => {
    const { runner, mutate, cancellation } = setup();
    await runner.run(
      "dev",
      { type: "batch", operation: "restart" },
      [res(kinds.deployment, "a"), res(kinds.statefulSet, "b")],
      cancellation.token,
    );
    const bodies = mutate.mock.calls.map((c) => c[3]);
    expect(bodies[0]).toEqual(
      expect.objectContaining({
        spec: {
          template: {
            metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": expect.stringMatching(/^\d{4}-/) } },
          },
        },
      }),
    );
    expect(bodies[0]).toMatchObject({ spec: (bodies[1] as { spec: unknown }).spec });
  });

  test("trigger creates Jobs from each template without copying status or server metadata", async () => {
    const { runner, mutate, cancellation } = setup();
    const cronjob = res(
      kinds.cronJob,
      "nightly",
      {
        spec: {
          jobTemplate: {
            metadata: { labels: { app: "batch" }, annotations: { note: "keep" } },
            spec: { template: { spec: { restartPolicy: "Never", containers: [{ name: "task", image: "busybox" }] } } },
          },
        },
        status: { active: [] },
      },
      "team-a",
    );
    await runner.run("dev", { type: "batch", operation: "trigger" }, [cronjob], cancellation.token);
    expect(mutate).toHaveBeenCalledWith(
      "dev",
      "/apis/batch/v1/namespaces/team-a/jobs",
      "POST",
      {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          generateName: "nightly-manual-",
          namespace: "team-a",
          labels: { app: "batch" },
          annotations: { note: "keep", "cronjob.kubernetes.io/instantiate": "manual" },
          ownerReferences: [
            {
              apiVersion: "batch/v1",
              kind: "CronJob",
              name: "nightly",
              uid: cronjob.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        },
        spec: (cronjob.object["spec"] as { jobTemplate: { spec: unknown } }).jobTemplate.spec,
      },
      expect.any(AbortSignal),
    );
  });

  test("validates every resource before starting any writes", async () => {
    const { runner, mutate, cancellation } = setup();
    await expect(
      runner.run(
        "dev",
        { type: "batch", operation: "delete" },
        [...pods, res(kinds.deployment, "web")],
        cancellation.token,
      ),
    ).rejects.toThrow("not supported");
    await expect(
      runner.run(
        "dev",
        { type: "batch", operation: "scale", replicas: "2147483648" },
        [res(kinds.deployment, "web")],
        cancellation.token,
      ),
    ).rejects.toThrow("Replicas must");
    expect(mutate).not.toHaveBeenCalled();
  });

  test("limits concurrency and continues after individual failures", async () => {
    let active = 0;
    let peak = 0;
    const mutate = vi.fn(async (...args: unknown[]) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (String(args[1]).endsWith("/p3")) throw new Error("Forbidden");
    });
    const { runner, cancellation } = setup(mutate);
    const targets = Array.from({ length: 12 }, (_, i) => res(kinds.pod, `p${i}`));
    const outcome = await runner.run("dev", { type: "batch", operation: "delete" }, targets, cancellation.token);
    expect(peak).toBe(4);
    expect(mutate).toHaveBeenCalledTimes(12);
    expect(outcome).toEqual({ succeeded: 11, failures: ["Pod default/p3: Forbidden"], cancelled: false });
  });

  test("cancellation stops scheduling remaining writes and aborts active requests", async () => {
    const { runner, mutate, cancellation } = setup(
      vi.fn(async (...args: unknown[]) => {
        cancellation.cancel();
        expect((args[4] as AbortSignal).aborted).toBe(true);
      }),
    );
    const outcome = await runner.run("dev", { type: "batch", operation: "delete" }, pods, cancellation.token);
    expect(outcome.cancelled).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
