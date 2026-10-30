import { beforeEach, describe, expect, test } from "vitest";
import { editFilter, pickRegion } from "../../../src/app/filterFlow";
import { Selection } from "../../../src/app/Selection";
import { signedInAuth } from "../helpers/aws";
import { FakePrompter, FakeSettings, FakeState } from "../helpers/fakes";

let prompter: FakePrompter;
let selection: Selection;

beforeEach(async () => {
  const state = new FakeState();
  const settings = new FakeSettings();
  settings.values.regions = ["eu-west-1", "us-east-1"];
  selection = new Selection(state, settings, await signedInAuth({ state, settings }));
  prompter = new FakePrompter();
});

describe("editFilter", () => {
  test("adds and replaces tag filters, removes them", async () => {
    prompter.answers.push("tag", "Owner=alice|bob");
    await editFilter(prompter, selection);
    prompter.answers.push("tag", "Owner=carol");
    await editFilter(prompter, selection);
    prompter.answers.push("tag", "Dev");
    await editFilter(prompter, selection);
    expect(selection.filter().tags).toEqual([
      { key: "Owner", values: ["carol"] },
      { key: "Dev", values: [] },
    ]);
    prompter.answers.push("removeTag", "Owner");
    await editFilter(prompter, selection);
    expect(selection.filter().tags).toEqual([{ key: "Dev", values: [] }]);
  });

  test("state, name, pinned only and clear", async () => {
    prompter.answers.push("state", "running", "name", " web ", "pinned");
    await editFilter(prompter, selection);
    await editFilter(prompter, selection);
    await editFilter(prompter, selection);
    expect(selection.filter()).toEqual({ tags: [], states: ["running"], nameContains: "web", pinnedOnly: true });
    prompter.answers.push("clear");
    await editFilter(prompter, selection);
    expect(selection.filter()).toEqual({ tags: [], states: [], nameContains: "", pinnedOnly: false });
  });
});

describe("pickRegion", () => {
  test("picks a known region or types another one", async () => {
    prompter.answers.push("us-east-1");
    await pickRegion(prompter, selection);
    expect(selection.region()).toBe("us-east-1");
    prompter.answers.push(undefined);
    await pickRegion(prompter, selection);
    expect(selection.region()).toBe("us-east-1");
    const other = prompter.shown[0]?.items?.at(-1)?.value;
    prompter.answers.push(other, " ap-northeast-1 ");
    await pickRegion(prompter, selection);
    expect(selection.region()).toBe("ap-northeast-1");
  });
});
