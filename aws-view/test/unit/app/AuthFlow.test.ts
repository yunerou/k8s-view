import { beforeEach, describe, expect, test } from "vitest";
import { AuthFlow } from "../../../src/app/AuthFlow";
import { AuthService } from "../../../src/app/AuthService";
import { creds, FakeAuthApi, FakeConfigSource, MemoryCredentialFile } from "../helpers/aws";
import { FakeNotifier, FakePrompter, FakeRunner, FakeSettings, FakeState } from "../helpers/fakes";

let source: FakeConfigSource;
let api: FakeAuthApi;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let auth: AuthService;
let flow: AuthFlow;

beforeEach(async () => {
  source = new FakeConfigSource(
    "[default]\nregion = eu-west-1\n[profile dev-mfa]\nmfa_serial = arn:mfa\n",
    "[default]\naws_access_key_id = A\naws_secret_access_key = S\n",
  );
  api = new FakeAuthApi();
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  const state = new FakeState();
  auth = new AuthService(
    source,
    api,
    new MemoryCredentialFile(),
    state,
    new FakeSettings(),
    prompter,
    notifier,
    new FakeRunner(),
  );
  await auth.start();
  flow = new AuthFlow(auth, prompter, notifier);
});

describe("AuthFlow", () => {
  test("lists profiles with their kind and signs in right away", async () => {
    api.sessionImpl = async () => creds("S", new Date(Date.now() + 3_600_000));
    prompter.answers.push("dev-mfa", "123456");
    await flow.selectProfile();
    expect(prompter.shown[0]?.items?.map((i) => [i.label, i.description])).toEqual([
      ["default", "access key · eu-west-1"],
      ["dev-mfa", "access key + MFA"],
    ]);
    expect(auth.state()).toMatchObject({ status: "signedIn", profile: { name: "dev-mfa" } });
  });

  test("canceling the pick or the MFA prompt shows nothing", async () => {
    prompter.answers.push(undefined);
    await flow.selectProfile();
    prompter.answers.push("dev-mfa", undefined);
    await flow.selectProfile();
    expect(notifier.messages).toEqual([]);
    expect(auth.state().status).toBe("signedOut");
  });

  test("no profiles: explains how to create one", async () => {
    source.config = "";
    source.credentials = "";
    await flow.selectProfile();
    expect(notifier.messages[0]?.message).toMatch(/No AWS profiles found/);
  });

  test("sign-in errors are reported", async () => {
    api.resolveImpl = async () => {
      throw new Error("Profile default is broken");
    };
    prompter.answers.push("default");
    await flow.selectProfile();
    expect(notifier.messages).toEqual([{ level: "error", message: "Profile default is broken", actions: [] }]);
  });
});
