import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthService } from "../../../src/app/AuthService";
import { IdleReminder } from "../../../src/app/IdleReminder";
import { InstanceActions } from "../../../src/app/InstanceActions";
import { InstanceService } from "../../../src/app/InstanceService";
import { InstanceSettingsStore } from "../../../src/app/InstanceSettingsStore";
import { Selection } from "../../../src/app/Selection";
import { nextMidnight } from "../../../src/core/reminder";
import { FakeAwsApi, instance, signedInAuth } from "../helpers/aws";
import { FakeNotifier, FakePrompter, FakeSettings, FakeState, FakeWorkbench } from "../helpers/fakes";

const HOUR = 3_600_000;
let now: number;
let api: FakeAwsApi;
let state: FakeState;
let settings: FakeSettings;
let auth: AuthService;
let store: InstanceSettingsStore;
let instances: InstanceService;
let actions: InstanceActions;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let workbench: FakeWorkbench;
let reminder: IdleReminder;

const create = () =>
  new IdleReminder(instances, actions, api, auth, store, state, settings, workbench, notifier, prompter, () => now);
/** Lets the `.then()` after a notification run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  now = Date.parse("2026-10-30T12:00:00Z");
  api = new FakeAwsApi();
  state = new FakeState();
  settings = new FakeSettings();
  auth = await signedInAuth({ state, settings });
  store = new InstanceSettingsStore(state);
  instances = new InstanceService(
    api,
    auth,
    new Selection(state, settings, auth),
    store,
    async () => {},
    () => now,
  );
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  workbench = new FakeWorkbench();
  actions = new InstanceActions(instances, settings, prompter, notifier);
  reminder = create();
});

describe("IdleReminder in a local window", () => {
  beforeEach(async () => {
    api.instances = [
      instance({ id: "i-1", name: "box", launchTime: now - 5 * HOUR }),
      instance({ id: "i-2", launchTime: now - 9 * HOUR }),
    ];
    await store.update("i-1", { pinned: true });
  });

  test("reminds about pinned instances running too long, at most once an hour", async () => {
    await reminder.tick();
    expect(notifier.messages).toEqual([
      { level: "warn", message: "box has been running for 5h 0m.", actions: ["Stop", "Snooze 1h", "Not today"] },
    ]);
    await reminder.tick();
    now += 31 * 60_000;
    await reminder.tick();
    expect(notifier.messages).toHaveLength(1);
    now += 30 * 60_000;
    await reminder.tick();
    expect(notifier.messages).toHaveLength(2);
  });

  test("another window does not repeat a reminder that was just shown", async () => {
    await reminder.tick();
    await create().tick();
    expect(notifier.messages).toHaveLength(1);
  });

  test("Not today mutes until local midnight", async () => {
    notifier.reply = "Not today";
    await reminder.tick();
    await flush();
    expect(state.getGlobal("awsView.reminder")).toEqual({
      "i-1": { nextAt: now + HOUR, mutedUntil: nextMidnight(now) },
    });
  });

  test("Stop asks for confirmation, then stops the instance", async () => {
    notifier.reply = "Stop";
    prompter.answers.push(true);
    await reminder.tick();
    await flush();
    expect(api.calls).toContain("stop i-1 eu-west-1");
  });

  test("disabled: no check at all", async () => {
    settings.values.idleReminderEnabled = false;
    await reminder.tick();
    expect(notifier.messages).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});

describe("IdleReminder in the Remote window of an instance", () => {
  beforeEach(async () => {
    workbench.authority = "ssh-remote+aws-view-i-9";
    await store.update("i-9", { profile: "dev", region: "ap-southeast-1", name: "remote box" });
    api.instances = [instance({ id: "i-9", name: "remote box", launchTime: now - 2 * HOUR })];
  });

  test("tracks this window's instance and warns before stopping it", async () => {
    const fired = vi.fn();
    reminder.onDidChange(fired);
    await reminder.tick();
    expect(reminder.remoteInstanceId()).toBe("i-9");
    expect(reminder.remoteStatus()).toMatchObject({ instance: { id: "i-9" }, uptimeMs: 2 * HOUR });
    expect(api.targets.at(-1)).toEqual({ profile: "dev", region: "ap-southeast-1" });
    expect(notifier.messages).toEqual([]);
    expect(fired).toHaveBeenCalled();

    prompter.answers.push("Stop", true);
    await reminder.promptActions();
    expect(prompter.shown[0]?.title).toBe("remote box · up 2h 0m");
    expect(prompter.shown[1]).toMatchObject({
      kind: "confirm",
      value: "i-9 · t3.large\nThis window will lose its connection.",
    });
    expect(api.calls).toContain("stop i-9 ap-southeast-1");
    expect(reminder.remoteStatus()?.instance.state).toBe("stopping");
  });

  test("reminds after the configured hours and refreshes every 10 minutes", async () => {
    settings.values.idleReminderHours = 1;
    await reminder.tick();
    expect(notifier.messages[0]?.message).toBe("remote box has been running for 2h 0m.");
    const describes = () => api.calls.filter((c) => c.startsWith("describe")).length;
    now += 5 * 60_000;
    await reminder.tick();
    expect(describes()).toBe(1);
    now += 6 * 60_000;
    await reminder.tick();
    expect(describes()).toBe(2);
  });

  test("another profile is selected: nothing is fetched", async () => {
    await store.update("i-9", { profile: "other" });
    await reminder.tick();
    expect(reminder.remoteStatus()).toBeUndefined();
    expect(api.calls).toEqual([]);
  });
  test("checks uptime each minute while keeping the AWS refresh at ten minutes", async () => {
    settings.values.idleReminderHours = 2 + 1 / 60;
    await reminder.tick();
    expect(notifier.messages).toEqual([]);
    now += 60_000;
    await reminder.tick();
    expect(notifier.messages[0]?.message).toBe("remote box has been running for 2h 1m.");
    expect(api.calls.filter((c) => c.startsWith("describe"))).toHaveLength(1);
  });

  test("a profile change after fetching the remote instance prevents actions on the wrong target", async () => {
    await reminder.tick();
    await store.update("i-9", { profile: "other" });
    prompter.answers.push("Stop", true);
    await reminder.promptActions();
    expect(prompter.shown).toEqual([]);
    expect(api.calls.filter((c) => c.startsWith("stop"))).toEqual([]);
  });
});

test("background tick failures are caught and the next scheduled tick still runs", async () => {
  vi.useFakeTimers();
  try {
    const tick = vi.spyOn(reminder, "tick").mockRejectedValue(new Error("Storage unavailable"));
    reminder.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    reminder.dispose();
    vi.useRealTimers();
  }
});
