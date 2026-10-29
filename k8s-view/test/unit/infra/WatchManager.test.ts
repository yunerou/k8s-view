import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { KindRef } from "../../../src/app/ports/ResourceSource";
import type { KubeObject } from "../../../src/core/resource/KubeResource";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import {
  KubeTransport,
  type ListResult,
  type WatchEvent,
  type WatchHandle,
} from "../../../src/infra/kube/KubeTransport";
import { WatchManager } from "../../../src/infra/kube/WatchManager";
import { FakeSettings } from "../helpers/fakes";
import { kinds } from "../helpers/fixtures";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

interface ActiveWatch {
  key: string;
  rv: string;
  onEvent: (e: WatchEvent) => void;
  onDone: (err: unknown) => void;
  aborted: boolean;
  done: boolean;
}

class FakeTransport extends KubeTransport {
  async streamText(): Promise<void> {}
  lists: string[] = [];
  watches: ActiveWatch[] = [];
  data = new Map<string, KubeObject[]>();
  listErrors = new Map<string, Error>();
  rv = 100;
  async list(context: string, kind: ResourceKind, ns: string | undefined): Promise<ListResult> {
    const key = `${context}|${kind.key}|${ns ?? "*"}`;
    this.lists.push(key);
    const err = this.listErrors.get(key);
    if (err) throw err;
    return { items: this.data.get(key) ?? [], resourceVersion: String(++this.rv) };
  }
  async watch(
    context: string,
    kind: ResourceKind,
    ns: string | undefined,
    rv: string,
    onEvent: (e: WatchEvent) => void,
    onDone: (err: unknown) => void,
  ): Promise<WatchHandle> {
    const w: ActiveWatch = {
      key: `${context}|${kind.key}|${ns ?? "*"}`,
      rv,
      onEvent,
      onDone: (err) => {
        w.done = true;
        onDone(err);
      },
      aborted: false,
      done: false,
    };
    this.watches.push(w);
    return { abort: () => (w.aborted = true) };
  }
  async getJson<T>(): Promise<T> {
    throw new Error("unused");
  }
  live() {
    return this.watches.filter((w) => !w.aborted && !w.done);
  }
}

const pod = (name: string, rv = "1", extra: Partial<KubeObject> = {}): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name,
    namespace: "a",
    uid: `uid-${name}`,
    resourceVersion: rv,
    managedFields: [{}],
  } as KubeObject["metadata"],
  ...extra,
});

const podRef: KindRef = { group: "", kind: "Pod" };
let transport: FakeTransport;
let settings: FakeSettings;
let manager: WatchManager;
let changes: string[];

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  settings = new FakeSettings();
  const known = new Map<string, ResourceKind>([
    [kinds.pod.key, kinds.pod],
    ["metrics.k8s.io/PodMetrics", new ResourceKind("metrics.k8s.io", "v1beta1", "PodMetrics", "pods", true)],
    [kinds.secret.key, kinds.secret],
  ]);
  manager = new WatchManager(
    transport,
    { resolve: async (_c: string, r: KindRef) => known.get(`${r.group}/${r.kind}`) },
    settings,
    { warn() {}, info() {} },
  );
  changes = [];
  manager.onDidChange((c) => changes.push(`${c.context}|${c.kindKey}|${c.namespace ?? "*"}`));
});

afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

describe("WatchManager", () => {
  test("lists then watches from the list resourceVersion", async () => {
    transport.data.set("dev|/Pod|a", [pod("p1")]);
    manager.acquire("dev", podRef, "a");
    expect(manager.entry("dev", podRef, "a")?.state).toBe("loading");
    await flush();
    const entry = manager.entry("dev", podRef, "a")!;
    expect(entry.state).toBe("live");
    expect(entry.store!.items().map((r) => r.name)).toEqual(["p1"]);
    expect(entry.store!.items()[0]!.object.metadata["managedFields"]).toBeUndefined();
    expect(transport.live()).toMatchObject([{ key: "dev|/Pod|a", rv: "101" }]);
    expect(changes).toContain("dev|/Pod|a");
  });

  test("applies watch events", async () => {
    manager.acquire("dev", podRef, "a");
    await flush();
    const w = transport.live()[0]!;
    w.onEvent({ type: "ADDED", object: pod("p2") });
    w.onEvent({ type: "MODIFIED", object: pod("p2", "2", { status: { phase: "Running" } } as Partial<KubeObject>) });
    expect(manager.entry("dev", podRef, "a")!.store!.items()[0]!.object["status"]).toEqual({ phase: "Running" });
    w.onEvent({ type: "DELETED", object: pod("p2", "3") });
    expect(manager.entry("dev", podRef, "a")!.store!.size).toBe(0);
  });

  test("410 Gone relists", async () => {
    manager.acquire("dev", podRef, "a");
    await flush();
    transport.live()[0]!.onEvent({ type: "ERROR", object: { code: 410, message: "too old" } as WatchEvent["object"] });
    await flush();
    expect(transport.lists).toEqual(["dev|/Pod|a", "dev|/Pod|a"]);
    expect(transport.live()).toHaveLength(1);
  });

  test("normal close re-watches from the last resourceVersion without relisting", async () => {
    manager.acquire("dev", podRef, "a");
    await flush();
    const w = transport.live()[0]!;
    w.onEvent({ type: "BOOKMARK", object: { metadata: { resourceVersion: "555" } } as WatchEvent["object"] });
    w.onDone(undefined);
    await flush();
    expect(transport.lists).toHaveLength(1);
    expect(transport.live().at(-1)!.rv).toBe("555");
  });

  test("network errors back off from 1s up to 30s", async () => {
    manager.acquire("dev", podRef, "a");
    await flush();
    transport.live()[0]!.onDone(new Error("ECONNRESET"));
    await flush();
    expect(manager.entry("dev", podRef, "a")!.state).toBe("error");
    expect(transport.lists).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.lists).toHaveLength(2);
    expect(manager.entry("dev", podRef, "a")!.state).toBe("live");
  });

  test("403 on watch falls back to polling", async () => {
    settings.values.poll = 10;
    manager.acquire("dev", podRef, "a");
    await flush();
    transport.live()[0]!.onDone(new HttpError(403));
    await flush();
    expect(manager.entry("dev", podRef, "a")!.state).toBe("polling");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.lists).toHaveLength(2);
    expect(transport.live()).toHaveLength(0);
  });

  test("403 on list marks the entry forbidden", async () => {
    transport.listErrors.set("dev|/Pod|*", new HttpError(403));
    manager.acquire("dev", podRef, undefined);
    await flush();
    expect(manager.entry("dev", podRef, undefined)!.state).toBe("forbidden");
  });

  test("unknown kinds are unavailable", async () => {
    manager.acquire("dev", { group: "x.io", kind: "Nope" }, "a");
    await flush();
    expect(manager.entry("dev", { group: "x.io", kind: "Nope" }, "a")!.state).toBe("unavailable");
  });

  test("shares one watch between leases and closes 30s after the last release", async () => {
    const l1 = manager.acquire("dev", podRef, "a");
    const l2 = manager.acquire("dev", podRef, "a");
    await flush();
    expect(transport.lists).toHaveLength(1);
    l1.dispose();
    l2.dispose();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(transport.live()).toHaveLength(1);
    const l3 = manager.acquire("dev", podRef, "a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.live()).toHaveLength(1);
    l3.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.live()).toHaveLength(0);
    expect(manager.entry("dev", podRef, "a")).toBeUndefined();
  });

  test("pause aborts watches; resume relists", async () => {
    manager.acquire("dev", podRef, "a");
    await flush();
    manager.setPaused(true);
    expect(transport.live()).toHaveLength(0);
    expect(manager.entry("dev", podRef, "a")!.state).toBe("paused");
    expect(manager.summary().state).toBe("paused");
    manager.setPaused(false);
    await flush();
    expect(transport.lists).toHaveLength(2);
    expect(manager.entry("dev", podRef, "a")!.state).toBe("live");
  });

  test("manual mode lists once without watching; resync relists", async () => {
    settings.values.mode = "manual";
    manager.acquire("dev", podRef, "a");
    await flush();
    expect(transport.live()).toHaveLength(0);
    manager.resync("dev");
    await flush();
    expect(transport.lists).toHaveLength(2);
  });

  test("respects maxWatches by polling the overflow", async () => {
    settings.values.maxWatches = 1;
    manager.acquire("dev", podRef, "a");
    manager.acquire("dev", podRef, "b");
    await flush();
    expect(transport.live()).toHaveLength(1);
    expect(manager.entry("dev", podRef, "b")!.state).toBe("polling");
  });

  test("releasing a lease of a closed entry does not remove its replacement", async () => {
    const old = manager.acquire("dev", podRef, "a");
    await flush();
    manager.closeContextsExcept("prod");
    manager.acquire("dev", podRef, "a");
    await flush();
    old.dispose();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(manager.entry("dev", podRef, "a")?.state).toBe("live");
    expect(transport.live().map((w) => w.key)).toEqual(["dev|/Pod|a"]);
  });

  test("closeContext drops every entry of another context", async () => {
    manager.acquire("dev", podRef, "a");
    manager.acquire("prod", podRef, "a");
    await flush();
    manager.closeContextsExcept("prod");
    expect(transport.live().map((w) => w.key)).toEqual(["prod|/Pod|a"]);
  });
});

test("metrics poll without watch and retain every object without UID or resourceVersion", async () => {
  const ref = { group: "metrics.k8s.io", kind: "PodMetrics" };
  const key = "dev|metrics.k8s.io/PodMetrics|a";
  const metric = (name: string, cpu: string) =>
    ({ metadata: { name, namespace: "a" }, containers: [{ usage: { cpu } }] }) as unknown as KubeObject;
  transport.data.set(key, [metric("p1", "100m"), metric("p2", "200m")]);
  manager.acquire("dev", ref, "a");
  await flush();
  expect(manager.entry("dev", ref, "a")?.state).toBe("polling");
  expect(
    manager
      .entry("dev", ref, "a")
      ?.store?.items()
      .map((r) => r.name),
  ).toEqual(["p1", "p2"]);
  expect(transport.watches).toHaveLength(0);
  transport.data.set(key, [metric("p1", "500m")]);
  await vi.advanceTimersByTimeAsync(settings.pollIntervalSeconds() * 1000);
  expect(manager.entry("dev", ref, "a")?.store?.items()).toHaveLength(1);
  expect(manager.entry("dev", ref, "a")?.store?.items()[0]?.object["containers"]).toEqual([{ usage: { cpu: "500m" } }]);
  manager.setPaused(true);
  const count = transport.lists.length;
  await vi.advanceTimersByTimeAsync(settings.pollIntervalSeconds() * 1000);
  expect(transport.lists).toHaveLength(count);
  manager.setPaused(false);
  await flush();
  expect(transport.lists).toHaveLength(count + 1);
});

test("metrics in manual mode list only on refresh, and ignore pending results after context closes", async () => {
  settings.set({ mode: "manual" });
  const ref = { group: "metrics.k8s.io", kind: "PodMetrics" };
  manager.acquire("dev", ref, "a");
  await flush();
  expect(transport.lists).toHaveLength(1);
  expect(transport.watches).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(transport.lists).toHaveLength(1);
  manager.resync("dev", [ref]);
  await flush();
  expect(transport.lists).toHaveLength(2);
  manager.resync("dev", [ref]);
  manager.closeContextsExcept("prod");
  await flush();
  expect(manager.entry("dev", ref, "a")).toBeUndefined();
  expect(transport.watches).toHaveLength(0);
});
