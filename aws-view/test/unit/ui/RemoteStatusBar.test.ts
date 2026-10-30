import { beforeEach, describe, expect, test, vi } from "vitest";
import type { IdleReminder, RemoteStatus } from "../../../src/app/IdleReminder";
import { Emitter } from "../../../src/core/util/Emitter";
import { RemoteStatusBar } from "../../../src/ui/RemoteStatusBar";
import { instance } from "../helpers/aws";

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

let status: RemoteStatus | undefined;
const changed = new Emitter<void>();
const reminder = { onDidChange: changed.event, remoteStatus: () => status } as unknown as IdleReminder;

beforeEach(() => {
  items.clear();
  status = undefined;
});

describe("RemoteStatusBar", () => {
  test("hidden outside an AWS View Remote window, uptime inside", () => {
    const bar = new RemoteStatusBar(reminder);
    bar.start();
    const item = items.get("awsView.remote")!;
    expect(item["shown"]).toBe(false);
    status = { instance: instance({ id: "i-9", name: "box" }), uptimeMs: 2 * 3_600_000 + 15 * 60_000 };
    changed.fire();
    expect(item).toMatchObject({ text: "$(vm-running) box · 2h 15m", command: "awsView.remoteActions", shown: true });
    status = { instance: instance({ id: "i-9", name: "box", state: "stopping" }), uptimeMs: undefined };
    changed.fire();
    expect(item["text"]).toBe("$(vm) box · stopping");
    bar.dispose();
  });
});
