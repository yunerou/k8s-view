import { beforeEach, describe, expect, test } from "vitest";
import { InstanceActions } from "../../../src/app/InstanceActions";
import { InstanceService } from "../../../src/app/InstanceService";
import { InstanceSettingsStore } from "../../../src/app/InstanceSettingsStore";
import { Selection } from "../../../src/app/Selection";
import { FakeAwsApi, instance, signedInAuth } from "../helpers/aws";
import { FakeNotifier, FakePrompter, FakeSettings, FakeState } from "../helpers/fakes";

let api: FakeAwsApi;
let settings: FakeSettings;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let actions: InstanceActions;

beforeEach(async () => {
  api = new FakeAwsApi();
  const state = new FakeState();
  settings = new FakeSettings();
  const auth = await signedInAuth({ state, settings });
  const service = new InstanceService(
    api,
    auth,
    new Selection(state, settings, auth),
    new InstanceSettingsStore(state),
  );
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  actions = new InstanceActions(service, settings, prompter, notifier);
});

describe("InstanceActions", () => {
  const box = instance({ id: "i-1", name: "box" });

  test("stop asks for confirmation unless disabled", async () => {
    prompter.answers.push(false);
    expect(await actions.stop(box)).toBe(false);
    expect(prompter.shown[0]).toMatchObject({ kind: "confirm", title: "Stop box?", value: "i-1 · t3.large" });
    expect(api.calls).toEqual([]);
    settings.values.confirmStop = false;
    expect(await actions.stop(box)).toBe(true);
    expect(api.calls).toEqual(["stop i-1 eu-west-1"]);
  });

  test("a warning always asks, and a target can be given", async () => {
    settings.values.confirmStop = false;
    prompter.answers.push(true);
    await actions.stop(box, {
      warning: "This window will lose its connection.",
      target: { profile: "dev", region: "us-east-1" },
    });
    expect(prompter.shown[0]?.value).toBe("i-1 · t3.large\nThis window will lose its connection.");
    expect(api.calls).toEqual(["stop i-1 us-east-1"]);
  });

  test("AWS errors are shown", async () => {
    api.startInstance = async () => {
      throw Object.assign(new Error("x not authorized to perform: ec2:StartInstances"), {
        name: "UnauthorizedOperation",
      });
    };
    await actions.start(box);
    expect(notifier.messages).toEqual([
      { level: "error", message: "Missing IAM permission: ec2:StartInstances.", actions: [] },
    ]);
  });
  test("rename edits the Name tag; an unchanged name does nothing", async () => {
    prompter.answers.push("new box", "box", "");
    await actions.rename(box);
    expect(prompter.shown[0]).toMatchObject({ kind: "input", title: "Rename box", value: "box" });
    await actions.rename(box);
    await actions.rename(box);
    expect(api.calls.filter((c) => c.includes("Tags"))).toEqual([
      'createTags i-1 {"Name":"new box"}',
      "deleteTags i-1 Name",
    ]);
  });
});
