import { beforeEach, describe, expect, test } from "vitest";
import { AuthService } from "../../../src/app/AuthService";
import { isCanceled } from "../../../src/core/util/errors";
import { creds, FakeAuthApi, FakeConfigSource, MemoryCredentialFile } from "../helpers/aws";
import { FakeNotifier, FakePrompter, FakeRunner, FakeSettings, FakeState } from "../helpers/fakes";

const CONFIG = `
[default]
region = eu-west-1
[profile dev-mfa]
mfa_serial = arn:aws:iam::1:mfa/dev
duration_seconds = 7200
[profile admin]
role_arn = arn:aws:iam::1:role/Admin
source_profile = default
mfa_serial = arn:aws:iam::1:mfa/dev
[profile corp]
sso_session = corp
sso_account_id = 1
`;
const CREDENTIALS = `
[default]
aws_access_key_id = A
aws_secret_access_key = S
[dev-mfa]
aws_access_key_id = B
aws_secret_access_key = T
`;
const MFA_REJECTED = () =>
  Object.assign(new Error("MultiFactorAuthentication failed with invalid MFA one time pass code."), {
    name: "AccessDenied",
  });

let now: number;
let state: FakeState;
let api: FakeAuthApi;
let file: MemoryCredentialFile;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let runner: FakeRunner;
let auth: AuthService;

const create = () =>
  new AuthService(
    new FakeConfigSource(CONFIG, CREDENTIALS),
    api,
    file,
    state,
    new FakeSettings(),
    prompter,
    notifier,
    runner,
    () => now,
  );

beforeEach(() => {
  now = Date.parse("2026-10-30T08:00:00Z");
  state = new FakeState();
  api = new FakeAuthApi();
  file = new MemoryCredentialFile();
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  runner = new FakeRunner();
  auth = create();
});

describe("AuthService", () => {
  test("without a saved profile nothing is selected", async () => {
    await auth.start();
    expect(auth.state()).toEqual({ status: "noProfile" });
    expect(auth.profiles().map((p) => [p.name, p.kind])).toEqual([
      ["default", "static"],
      ["admin", "assumeRole"],
      ["corp", "sso"],
      ["dev-mfa", "staticMfa"],
    ]);
  });

  test("a static profile is restored at start without prompting", async () => {
    await state.setGlobal("awsView.profile", "default");
    await auth.start();
    expect(auth.state()).toMatchObject({ status: "signedIn", profile: { name: "default" }, expiresAt: undefined });
    expect(api.calls).toEqual(["resolve default eu-west-1"]);
    expect(prompter.shown).toEqual([]);
    expect(auth.cliEnv("eu-west-1")).toEqual({ AWS_PROFILE: "default", AWS_REGION: "eu-west-1" });
  });

  test("MFA profile: asks a code, calls GetSessionToken, shares the session with other windows", async () => {
    api.sessionImpl = async () => creds("SESSION", new Date(now + 7_200_000));
    await auth.start();
    await auth.selectProfile("dev-mfa");
    expect(auth.state().status).toBe("signedOut");
    expect(state.getGlobal("awsView.profile")).toBe("dev-mfa");

    prompter.answers.push("123456");
    expect((await auth.credentials()).accessKeyId).toBe("SESSION");
    expect(api.calls).toEqual([
      "resolve dev-mfa us-east-1",
      "session STATIC-dev-mfa arn:aws:iam::1:mfa/dev 123456 7200",
    ]);
    expect(file.saved.get("dev-mfa-aws-view")?.accessKeyId).toBe("SESSION");
    expect(auth.state()).toMatchObject({ status: "signedIn", expiresAt: now + 7_200_000 });
    expect(auth.cliEnv("eu-west-1")).toEqual({
      AWS_PROFILE: "dev-mfa-aws-view",
      AWS_REGION: "eu-west-1",
      AWS_SHARED_CREDENTIALS_FILE: "/storage/credentials",
    });

    // Another window, or VS Code restarted: the saved session is reused, no new MFA prompt.
    const other = create();
    await other.start();
    expect(other.state().status).toBe("signedIn");
    expect((await other.credentials()).accessKeyId).toBe("SESSION");
    expect(prompter.shown).toHaveLength(1);
  });

  test("a saved session about to expire is ignored and a new code is asked", async () => {
    await file.write("dev-mfa-aws-view", creds("OLD", new Date(now + 30_000)));
    await state.setGlobal("awsView.profile", "dev-mfa");
    await auth.start();
    expect(auth.state().status).toBe("signedOut");
    api.sessionImpl = async () => creds("NEW", new Date(now + 3_600_000));
    prompter.answers.push("111111");
    expect((await auth.credentials()).accessKeyId).toBe("NEW");
  });

  test("a rejected MFA code is asked again, at most three times", async () => {
    await auth.start();
    await auth.selectProfile("dev-mfa");
    let attempts = 0;
    api.sessionImpl = async () => {
      attempts++;
      if (attempts < 3) throw MFA_REJECTED();
      return creds("OK", new Date(now + 3_600_000));
    };
    prompter.answers.push("000000", "111111", "222222");
    expect((await auth.credentials()).accessKeyId).toBe("OK");
    expect(prompter.shown.map((s) => s.kind)).toEqual(["input", "input", "input"]);

    await auth.signOut();
    expect(file.saved.has("dev-mfa-aws-view")).toBe(false);
    api.sessionImpl = async () => {
      throw MFA_REJECTED();
    };
    prompter.answers.push("333333", "444444", "555555");
    await expect(auth.credentials()).rejects.toThrow(/MultiFactorAuthentication/);
    expect(prompter.shown).toHaveLength(6);
    expect(auth.state().status).toBe("signedOut");
  });

  test("dismissing the MFA prompt cancels quietly", async () => {
    await auth.start();
    await auth.selectProfile("dev-mfa");
    prompter.answers.push(undefined);
    const error = await auth.credentials().catch((e: unknown) => e);
    expect(isCanceled(error)).toBe(true);
    expect(auth.state().status).toBe("signedOut");
  });

  test("assume role: the MFA callback prompts only when the SDK calls it", async () => {
    api.resolveImpl = async (profile, mfaCode) => {
      if (profile !== "admin") return creds("STATIC");
      const code = await mfaCode("arn:aws:iam::1:mfa/dev");
      return creds(`ROLE-${code}`, new Date(now + 3_600_000));
    };
    await auth.start();
    await auth.selectProfile("admin");
    prompter.answers.push("654321");
    expect((await auth.credentials()).accessKeyId).toBe("ROLE-654321");
    expect(file.saved.get("admin-aws-view")?.accessKeyId).toBe("ROLE-654321");
    expect(prompter.shown).toHaveLength(1);
  });

  test("SSO: an expired session runs `aws sso login`, then resolves again", async () => {
    let loggedIn = false;
    api.resolveImpl = async () => {
      if (!loggedIn) {
        throw new Error(
          "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login",
        );
      }
      return creds("SSO", new Date(now + 3_600_000));
    };
    runner.handler = () => {
      loggedIn = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    await auth.start();
    await auth.selectProfile("corp");
    expect(auth.state().status).toBe("signedOut");
    expect((await auth.credentials()).accessKeyId).toBe("SSO");
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([["aws", "sso", "login", "--profile", "corp"]]);
    expect(notifier.progressTitles).toEqual(["Signing in to corp with AWS SSO (finish in your browser)…"]);
    expect(auth.cliEnv("ap-southeast-1")).toEqual({ AWS_PROFILE: "corp", AWS_REGION: "ap-southeast-1" });
  });

  test("a failed `aws sso login` is reported with its output", async () => {
    api.resolveImpl = async () => {
      throw new Error("The SSO session associated with this profile has expired");
    };
    runner.handler = () => ({ code: 255, stdout: "", stderr: "Error loading SSO Token\n" });
    await auth.start();
    await auth.selectProfile("corp");
    await expect(auth.credentials()).rejects.toThrow("aws sso login failed: Error loading SSO Token");
  });

  test("concurrent calls share one sign-in", async () => {
    await auth.start();
    await auth.selectProfile("dev-mfa");
    api.sessionImpl = async () => creds("S", new Date(now + 3_600_000));
    prompter.answers.push("123456");
    const [a, b] = await Promise.all([auth.credentials(), auth.credentials()]);
    expect(a).toBe(b);
    expect(prompter.shown).toHaveLength(1);
  });

  test("unknown profiles are rejected", async () => {
    await auth.start();
    await expect(auth.selectProfile("nope")).rejects.toThrow('AWS profile "nope" not found.');
  });
  test("signing out prevents an in-flight MFA response from restoring the session", async () => {
    await auth.start();
    await auth.selectProfile("dev-mfa");
    let release!: (value: ReturnType<typeof creds>) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    api.sessionImpl = () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    prompter.answers.push("123456");
    const pending = auth.signIn();
    const result = pending.catch((e: unknown) => e);
    await entered;
    await auth.signOut();
    release(creds("STALE", new Date(now + 3_600_000)));
    expect(isCanceled(await result)).toBe(true);
    expect(auth.state().status).toBe("signedOut");
    expect(file.saved.has("dev-mfa-aws-view")).toBe(false);
  });
});
