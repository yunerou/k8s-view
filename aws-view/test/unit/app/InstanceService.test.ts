import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthService } from "../../../src/app/AuthService";
import { InstanceService, SsmTimeoutError } from "../../../src/app/InstanceService";
import { InstanceSettingsStore } from "../../../src/app/InstanceSettingsStore";
import { Selection } from "../../../src/app/Selection";
import type { Instance, InstanceState, SsmPing } from "../../../src/core/ec2/model";
import { isCanceled } from "../../../src/core/util/errors";
import { FakeAwsApi, instance, signedInAuth } from "../helpers/aws";
import { FakeSettings, FakeState } from "../helpers/fakes";

let now: number;
let api: FakeAwsApi;
let state: FakeState;
let settings: FakeSettings;
let auth: AuthService;
let selection: Selection;
let store: InstanceSettingsStore;
let service: InstanceService;

const make = (sleep: () => Promise<void> = async () => {}) =>
  new InstanceService(api, auth, selection, store, sleep, () => now);
const ready = (s = service) => {
  const ls = s.listState();
  if (ls.kind !== "ready") throw new Error(`not ready: ${ls.kind}`);
  return ls;
};
const ids = (s = service) => ready(s).instances.map((i) => i.id);

beforeEach(async () => {
  now = Date.parse("2026-10-30T08:00:00Z");
  api = new FakeAwsApi();
  state = new FakeState();
  settings = new FakeSettings();
  auth = await signedInAuth({ state, settings });
  selection = new Selection(state, settings, auth);
  store = new InstanceSettingsStore(state);
  service = make();
});

afterEach(() => {
  service.dispose();
  vi.useRealTimers();
});

describe("InstanceService: listing", () => {
  test("lists instances of the selected region with their SSM status, sorted by name", async () => {
    api.instances = [instance({ id: "i-2", name: "web" }), instance({ id: "i-1", name: "api", state: "stopped" })];
    api.pings.set("i-2", "Online");
    expect(service.listState()).toEqual({ kind: "loading" });
    await service.refresh();
    expect(ready().instances.map((i) => [i.id, i.ssm])).toEqual([
      ["i-1", undefined],
      ["i-2", "Online"],
    ]);
    expect(api.targets[0]).toEqual({ profile: "dev", region: "eu-west-1" });
    expect(api.filters[0]).toEqual([
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] },
    ]);
  });

  test("client-side filters: name and pinned only", async () => {
    api.instances = [instance({ id: "i-1", name: "api" }), instance({ id: "i-2", name: "web" })];
    await selection.setFilter({ ...selection.filter(), nameContains: "we" });
    await service.refresh();
    expect(ids()).toEqual(["i-2"]);
    await store.update("i-1", { pinned: true });
    await selection.setFilter({ ...selection.filter(), nameContains: "", pinnedOnly: true });
    await service.refresh();
    expect(ids()).toEqual(["i-1"]);
  });

  test("signed out or without region: nothing is requested", async () => {
    await auth.signOut();
    await service.refresh();
    expect(service.listState()).toEqual({ kind: "signedOut", profile: "dev" });
    const noRegionAuth = await signedInAuth({ region: null });
    const other = new InstanceService(api, noRegionAuth, new Selection(new FakeState(), settings, noRegionAuth), store);
    await other.refresh();
    expect(other.listState()).toEqual({ kind: "noRegion" });
    expect(api.calls).toEqual([]);
    other.dispose();
  });

  test("an error keeps the previous list and is shown", async () => {
    api.instances = [instance({ id: "i-1" })];
    await service.refresh();
    api.failWith = Object.assign(
      new Error(
        "You are not authorized to perform this operation. ... not authorized to perform: ec2:DescribeInstances",
      ),
      { name: "UnauthorizedOperation" },
    );
    await service.refresh();
    expect(ready()).toMatchObject({ error: "Missing IAM permission: ec2:DescribeInstances." });
    expect(ids()).toEqual(["i-1"]);
  });

  test("a stale response after a region change is dropped", async () => {
    let releaseOld!: (list: Instance[]) => void;
    api.describeImpl = (t) =>
      t.region === "eu-west-1"
        ? new Promise((resolve) => {
            releaseOld = resolve;
          })
        : Promise.resolve([instance({ id: "i-us" })]);
    const old = service.refresh();
    await selection.setRegion("us-east-1");
    await service.refresh();
    releaseOld([instance({ id: "i-eu" })]);
    await old;
    expect(ids()).toEqual(["i-us"]);
  });

  test("polls every 5 s while an instance changes state, every 60 s while the view is visible", async () => {
    vi.useFakeTimers();
    api.instances = [instance({ id: "i-1", state: "pending" })];
    await service.refresh();
    const describes = () => api.calls.filter((c) => c.startsWith("describe")).length;
    expect(describes()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(describes()).toBe(2);
    api.instances = [instance({ id: "i-1", state: "running" })];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(describes()).toBe(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(describes()).toBe(3);
    service.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(describes()).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(describes()).toBe(5);
  });
});

describe("InstanceService: actions", () => {
  test("start and stop call EC2 and show the transition right away", async () => {
    api.instances = [instance({ id: "i-1", state: "stopped" })];
    await service.refresh();
    await service.start("i-1");
    expect(ready().instances[0]?.state).toBe("pending");
    await service.stop("i-1", { profile: "dev", region: "ap-southeast-1" });
    expect(api.calls).toContain("start i-1");
    expect(api.calls).toContain("stop i-1 ap-southeast-1");
  });

  test("rename sets or removes the Name tag", async () => {
    await service.rename("i-1", " box ");
    await service.rename("i-1", "  ");
    expect(api.calls.filter((c) => c.includes("Tags"))).toEqual([
      'createTags i-1 {"Name":"box"}',
      "deleteTags i-1 Name",
    ]);
  });
});

describe("InstanceService: ensureOnline", () => {
  const timeline = (steps: [InstanceState, SsmPing | undefined][]) => {
    let step = 0;
    api.onDescribe = () => {
      const [state, ping] = steps[Math.min(step++, steps.length - 1)]!;
      api.instances = [instance({ id: "i-1", state })];
      if (ping) api.pings.set("i-1", ping);
      else api.pings.delete("i-1");
    };
  };

  test("starts a stopped instance and waits for the SSM agent", async () => {
    timeline([
      ["stopped", undefined],
      ["pending", undefined],
      ["running", undefined],
      ["running", "Online"],
    ]);
    const messages: string[] = [];
    const result = await service.ensureOnline("i-1", new AbortController().signal, (m) => messages.push(m));
    expect(result).toMatchObject({ id: "i-1", state: "running", ssm: "Online" });
    expect(api.calls.filter((c) => c.startsWith("start"))).toEqual(["start i-1"]);
    expect(messages).toEqual(["Starting instance…", "Waiting for the instance to run…", "Waiting for the SSM agent…"]);
  });

  test("a stopping instance is started once it has stopped", async () => {
    timeline([
      ["stopping", undefined],
      ["stopped", undefined],
      ["running", "Online"],
    ]);
    const messages: string[] = [];
    await service.ensureOnline("i-1", new AbortController().signal, (m) => messages.push(m));
    expect(messages).toEqual(["Waiting for the instance to stop before starting it…", "Starting instance…"]);
  });

  test("gives up after 5 minutes without SSM, with hints", async () => {
    timeline([["running", undefined]]);
    const slow = make(async () => {
      now += 60_000;
    });
    const error = await slow.ensureOnline("i-1", new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsmTimeoutError);
    expect((error as Error).message).toMatch(/AmazonSSMManagedInstanceCore/);
    slow.dispose();
  });

  test("cancel, terminated and missing instances", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCanceled(await service.ensureOnline("i-1", controller.signal).catch((e: unknown) => e))).toBe(true);
    timeline([["terminated", undefined]]);
    await expect(service.ensureOnline("i-1", new AbortController().signal)).rejects.toThrow("i-1 is terminated.");
    api.onDescribe = () => {
      api.instances = [];
    };
    await expect(service.ensureOnline("i-1", new AbortController().signal)).rejects.toThrow(
      "Instance i-1 was not found in eu-west-1.",
    );
  });
});

describe("InstanceService.saveTags", () => {
  test("deletes removed keys, writes new or changed ones and keeps aws: tags", async () => {
    api.instances = [
      instance({ id: "i-1", tags: { Name: "box", Owner: "me", Old: "x", "aws:cloudformation:stack-name": "s" } }),
    ];
    await service.refresh();
    const error = await service.saveTags("i-1", [
      { key: "Name", value: "box" },
      { key: "Owner", value: "you" },
      { key: "Env", value: "dev" },
      { key: "", value: "" },
    ]);
    expect(error).toBeUndefined();
    expect(api.calls.filter((c) => c.includes("Tags"))).toEqual([
      "deleteTags i-1 Old",
      'createTags i-1 {"Owner":"you","Env":"dev"}',
    ]);
    expect(service.get("i-1")?.tags).toEqual({
      Name: "box",
      Owner: "you",
      Env: "dev",
      "aws:cloudformation:stack-name": "s",
    });
  });

  test("invalid rows, unknown instances and AWS errors come back as a message", async () => {
    api.instances = [instance({ id: "i-1", tags: { Owner: "me" } })];
    await service.refresh();
    expect(
      await service.saveTags("i-1", [
        { key: "A", value: "1" },
        { key: "A", value: "2" },
      ]),
    ).toBe("Fix the highlighted tags first.");
    expect(await service.saveTags("i-404", [])).toBe("Instance i-404 is no longer listed. Refresh and try again.");
    api.deleteTags = async () => {
      throw Object.assign(new Error("not authorized to perform: ec2:DeleteTags"), { name: "UnauthorizedOperation" });
    };
    expect(await service.saveTags("i-1", [])).toBe("Missing IAM permission: ec2:DeleteTags.");
    expect(api.calls.filter((c) => c.includes("Tags"))).toEqual([]);
  });
});
