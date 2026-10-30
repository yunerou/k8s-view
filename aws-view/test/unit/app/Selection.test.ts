import { beforeEach, describe, expect, test, vi } from "vitest";
import { Selection } from "../../../src/app/Selection";
import { signedInAuth } from "../helpers/aws";
import { FakeSettings, FakeState } from "../helpers/fakes";

let state: FakeState;
let settings: FakeSettings;

beforeEach(() => {
  state = new FakeState();
  settings = new FakeSettings();
});

describe("Selection", () => {
  test("region: chosen > first configured region > profile region", async () => {
    const selection = new Selection(state, settings, await signedInAuth({ state, settings }));
    expect(selection.region()).toBe("eu-west-1");
    settings.set({ regions: ["ap-southeast-1", "us-east-1"] });
    expect(selection.region()).toBe("ap-southeast-1");
    await selection.setRegion("us-east-1");
    expect(selection.region()).toBe("us-east-1");
    expect(selection.regionChoices()).toEqual(["ap-southeast-1", "us-east-1", "eu-west-1"]);
    expect(selection.target()).toEqual({ profile: "dev", region: "us-east-1" });
  });

  test("no region anywhere: no target", async () => {
    const selection = new Selection(state, settings, await signedInAuth({ state, settings, region: null }));
    expect(selection.region()).toBeUndefined();
    expect(selection.target()).toBeUndefined();
  });

  test("filter defaults to the configured tag filters until changed; changes fire events", async () => {
    settings.values.defaultTagFilters = [{ key: "Owner", values: ["me"] }];
    const auth = await signedInAuth({ state, settings });
    const selection = new Selection(state, settings, auth);
    const fired = vi.fn();
    selection.onDidChange(fired);
    expect(selection.filter()).toEqual({
      tags: [{ key: "Owner", values: ["me"] }],
      states: [],
      nameContains: "",
      pinnedOnly: false,
    });
    await selection.setFilter({ ...selection.filter(), nameContains: "web" });
    expect(selection.filter().nameContains).toBe("web");
    await selection.clearFilter();
    expect(selection.filter().nameContains).toBe("");
    settings.set({ regions: ["us-east-1"] });
    settings.set({ confirmStop: false });
    await auth.signOut();
    expect(fired).toHaveBeenCalledTimes(4);
  });
});
