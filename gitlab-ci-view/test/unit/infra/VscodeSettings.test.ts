import { beforeEach, describe, expect, test, vi } from "vitest";

const { config } = vi.hoisted(() => ({
  config: { user: undefined as unknown, workspace: undefined as unknown, values: new Map<string, unknown>() },
}));

vi.mock("vscode", async (original) => {
  const actual = await original<typeof import("vscode")>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => (config.values.has(key) ? config.values.get(key) : fallback),
        inspect: (key: string) =>
          key === "hosts" ? { key, globalValue: config.user, workspaceValue: config.workspace } : undefined,
      }),
    },
  };
});

const { VscodeSettings } = await import("../../../src/infra/state/VscodeSettings");

beforeEach(() => {
  config.user = undefined;
  config.workspace = undefined;
  config.values.clear();
});

describe("VscodeSettings", () => {
  test("hosts come from user settings only, never from the workspace", () => {
    config.workspace = [{ host: "gitlab.com", apiUrl: "https://attacker.example" }];
    expect(new VscodeSettings().hosts()).toEqual([]);
  });

  test("hosts are normalised and invalid entries dropped", () => {
    config.user = [
      {
        host: " Git.Company.VN ",
        apiUrl: "https://git.company.vn/gitlab",
        sshAlias: "work",
        rejectUnauthorized: false,
      },
      { host: "" },
      "nope",
      { apiUrl: "https://no-host" },
      { host: "plain.host", caFile: "  " },
    ];
    expect(new VscodeSettings().hosts()).toEqual([
      { host: "git.company.vn", apiUrl: "https://git.company.vn/gitlab", sshAlias: "work", rejectUnauthorized: false },
      { host: "plain.host" },
    ]);
  });

  test("numbers are clamped and enums fall back to defaults", () => {
    config.values.set("refresh.activeSeconds", 1);
    config.values.set("refresh.idleSeconds", 2);
    config.values.set("notifications", "loud");
    config.values.set("tokenExpiryWarningDays", -3);
    config.values.set("defaultRefFilter", "weird");
    const s = new VscodeSettings();
    expect([s.activeRefreshSeconds(), s.idleRefreshSeconds()]).toEqual([3, 10]);
    expect(s.notifications()).toBe("failed");
    expect(s.tokenExpiryWarningDays()).toBe(0);
    expect(s.defaultRefFilter()).toBe("current");
  });
});
