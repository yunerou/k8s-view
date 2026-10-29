import { describe, expect, test } from "vitest";
import { HotkeyService } from "../../../src/app/HotkeyService";
import type { LoadedConfigFile } from "../../../src/app/ports/ConfigSource";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import type { ConfigOrigin } from "../../../src/core/config/origin";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import { parseChord } from "../../../src/shared/hotkeys";
import { FakeSettings, FakeState } from "../helpers/fakes";

const file = (id: string, origin: ConfigOrigin, hotkeys: object, preset?: string): LoadedConfigFile => ({
  id,
  origin,
  parsed: parseConfigText(JSON.stringify({ version: 1, hotkeys })),
  ...(preset ? { preset } : {}),
});
const ctx = { trusted: true, isPresetActive: (name: string | undefined) => name !== "off" };
const create = (state = new FakeState()) => new HotkeyService(state, new FakeSettings(), new ViewRegistry());
const actionOf = (service: HotkeyService, key: string) =>
  service.state().bindings.find((b) => b.key === parseChord(key))?.action;

describe("HotkeyService", () => {
  test("starts OFF with the default bindings", () => {
    const service = create();
    expect(service.state().enabled).toBe(false);
    expect(actionOf(service, "1")).toEqual({ favorite: 1 });
    expect(service.state().favorites).toEqual([]);
  });

  test("toggle persists the mode and fires a change", async () => {
    const state = new FakeState();
    const service = create(state);
    let fired = 0;
    service.onDidChange(() => fired++);
    await service.toggle();
    expect(service.state().enabled).toBe(true);
    expect(fired).toBe(1);
    expect(create(state).state().enabled).toBe(true);
  });

  test("later files win on the same key; inactive presets and untrusted workspaces are skipped", () => {
    const service = create();
    let fired = 0;
    service.onDidChange(() => fired++);
    service.apply(
      [
        file("p", "preset", { bindings: [{ key: "g", command: "flux.reconcile" }] }, "fluxcd"),
        file("off", "preset", { bindings: [{ key: "h", action: "help" }] }, "off"),
        file("u", "user", { bindings: [{ key: "1", view: "fluxcd" }] }),
        file("w", "workspace", { bindings: [{ key: "g", action: "refresh" }] }),
      ],
      ctx,
    );
    expect(actionOf(service, "g")).toEqual({ action: "refresh" });
    expect(actionOf(service, "1")).toEqual({ view: "fluxcd" });
    expect(actionOf(service, "h")).toBeUndefined();
    expect(fired).toBe(1);

    service.apply(
      [
        file("u", "user", { bindings: [{ key: "g", action: "help" }] }),
        file("w", "workspace", { bindings: [{ key: "g", action: "refresh" }] }),
      ],
      { ...ctx, trusted: false },
    );
    expect(actionOf(service, "g")).toEqual({ action: "help" });
  });
});
