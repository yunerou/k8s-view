import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthService } from "../../../src/app/AuthService";
import { StatusBarController } from "../../../src/ui/StatusBarController";
import { creds, FakeAuthApi, FakeConfigSource, MemoryCredentialFile } from "../helpers/aws";
import { FakeNotifier, FakePrompter, FakeRunner, FakeSettings, FakeState } from "../helpers/fakes";

const { items } = vi.hoisted(() => ({ items: new Map<string, Record<string, unknown>>() }));

vi.mock("vscode", async (original) => {
  const actual = await original<typeof import("vscode")>();
  return {
    ...actual,
    window: {
      ...actual.window,
      createStatusBarItem: (id: string) => {
        const item: Record<string, unknown> = {
          shown: false,
          show() {
            item["shown"] = true;
          },
          hide() {
            item["shown"] = false;
          },
          dispose() {},
        };
        items.set(id, item);
        return item;
      },
    },
  };
});

let now: number;
let api: FakeAuthApi;
let file: MemoryCredentialFile;
let state: FakeState;
let auth: AuthService;

beforeEach(async () => {
  items.clear();
  now = Date.parse("2026-10-30T08:00:00Z");
  api = new FakeAuthApi();
  file = new MemoryCredentialFile();
  state = new FakeState();
  auth = new AuthService(
    new FakeConfigSource(
      "[default]\n[profile dev-mfa]\nmfa_serial = arn:mfa\n",
      "[default]\naws_access_key_id = A\naws_secret_access_key = S\n",
    ),
    api,
    file,
    state,
    new FakeSettings(),
    new FakePrompter(),
    new FakeNotifier(),
    new FakeRunner(),
    () => now,
  );
});

describe("StatusBarController", () => {
  test("no profile, then a static profile", async () => {
    await auth.start();
    const bar = new StatusBarController(auth, () => now);
    bar.start();
    const item = items.get("awsView.auth")!;
    expect(item).toMatchObject({ text: "$(cloud) AWS: select profile", command: "awsView.selectProfile", shown: true });
    await auth.selectProfile("default");
    expect(item).toMatchObject({
      text: "$(cloud) default",
      command: "awsView.selectProfile",
      backgroundColor: undefined,
    });
    bar.dispose();
  });

  test("MFA session: time left, warning colour near the end, signed out after expiry", async () => {
    await file.write("dev-mfa-aws-view", creds("S", new Date(now + 2 * 3_600_000 + 5 * 60_000)));
    await state.setGlobal("awsView.profile", "dev-mfa");
    await auth.start();
    const bar = new StatusBarController(auth, () => now);
    bar.start();
    const item = items.get("awsView.auth")!;
    expect(item["text"]).toBe("$(cloud) dev-mfa · 2h 5m left");
    now += 2 * 3_600_000 - 5 * 60_000;
    bar.update();
    expect(item["text"]).toBe("$(cloud) dev-mfa · 10m left");
    expect(item["backgroundColor"]).toMatchObject({ id: "statusBarItem.warningBackground" });
    now += 10 * 60_000;
    bar.update();
    expect(item).toMatchObject({ text: "$(cloud) dev-mfa · signed out", command: "awsView.signIn" });
    bar.dispose();
  });
});
