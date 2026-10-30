import { beforeEach, describe, expect, test, vi } from "vitest";

const { config } = vi.hoisted(() => ({
  config: {
    values: new Map<string, unknown>(),
    user: new Map<string, unknown>(),
    workspace: new Map<string, unknown>(),
  },
}));

vi.mock("vscode", async (original) => {
  const actual = await original<typeof import("vscode")>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => (config.values.has(key) ? config.values.get(key) : fallback),
        inspect: (key: string) => ({
          key,
          globalValue: config.user.get(key),
          workspaceValue: config.workspace.get(key),
        }),
      }),
    },
  };
});

const { VscodeSettings } = await import("../../../src/infra/state/VscodeSettings");

beforeEach(() => {
  config.values.clear();
  config.user.clear();
  config.workspace.clear();
});

describe("VscodeSettings", () => {
  test("defaults", () => {
    const s = new VscodeSettings("/Users/me");
    expect(s.regions()).toEqual([]);
    expect(s.defaultTagFilters()).toEqual([]);
    expect([s.idleReminderEnabled(), s.idleReminderHours(), s.confirmStop()]).toEqual([true, 4, true]);
    expect(s.awsCliPath()).toBe("aws");
    expect(s.sshConfigPath()).toBe("/Users/me/.ssh/aws-view.config");
  });

  test("the CLI path and SSH config path come from user settings only", () => {
    config.workspace.set("awsCliPath", "/tmp/evil");
    config.workspace.set("sshConfigPath", "/tmp/evil.config");
    const s = new VscodeSettings("/Users/me");
    expect(s.awsCliPath()).toBe("aws");
    expect(s.sshConfigPath()).toBe("/Users/me/.ssh/aws-view.config");
    config.user.set("awsCliPath", " /opt/homebrew/bin/aws ");
    config.user.set("sshConfigPath", "~/custom/hosts");
    expect(s.awsCliPath()).toBe("/opt/homebrew/bin/aws");
    expect(s.sshConfigPath()).toBe("/Users/me/custom/hosts");
  });

  test("invalid values are dropped or clamped", () => {
    config.values.set("regions", [" eu-west-1 ", "nope", 3, "eu-west-1", "ap-southeast-1"]);
    config.values.set("defaultTagFilters", [
      { key: " Owner ", values: ["alice", "", 1] },
      { key: "" },
      "x",
      { key: "Env" },
    ]);
    config.values.set("idleReminder.hours", 0);
    config.values.set("idleReminder.enabled", false);
    const s = new VscodeSettings("/Users/me");
    expect(s.regions()).toEqual(["eu-west-1", "ap-southeast-1"]);
    expect(s.defaultTagFilters()).toEqual([
      { key: "Owner", values: ["alice"] },
      { key: "Env", values: [] },
    ]);
    expect(s.idleReminderHours()).toBe(0.01);
    expect(s.idleReminderEnabled()).toBe(false);
  });
});
