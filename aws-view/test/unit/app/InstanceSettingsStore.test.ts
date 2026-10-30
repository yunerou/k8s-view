import { describe, expect, test, vi } from "vitest";
import { InstanceSettingsStore } from "../../../src/app/InstanceSettingsStore";
import { FakeState } from "../helpers/fakes";

describe("InstanceSettingsStore", () => {
  test("merges, unsets, lists pinned instances and is shared through globalState", async () => {
    const state = new FakeState();
    const store = new InstanceSettingsStore(state);
    const fired = vi.fn();
    store.onDidChange(fired);
    await store.update("i-1", { sshUser: "ubuntu", pinned: true });
    await store.update("i-1", { fallbackKeyPath: "~/.ssh/k.pem" });
    await store.update("i-2", { pinned: false });
    expect(store.get("i-1")).toEqual({ sshUser: "ubuntu", pinned: true, fallbackKeyPath: "~/.ssh/k.pem" });
    expect([...store.pinned()]).toEqual(["i-1"]);
    await store.unset("i-1", "fallbackKeyPath");
    expect(new InstanceSettingsStore(state).get("i-1")).toEqual({ sshUser: "ubuntu", pinned: true });
    expect(store.get("i-404")).toEqual({});
    expect(fired).toHaveBeenCalledTimes(4);
  });
});
