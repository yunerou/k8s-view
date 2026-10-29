import { describe, expect, test } from "vitest";
import { DEFAULT_HOTKEYS, eventChord, parseChord, resolveHotkeys } from "../../../src/shared/hotkeys";

const key = (code: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  code,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("parseChord", () => {
  test("letters, digits and punctuation map to KeyboardEvent.code", () => {
    expect(parseChord("g")).toBe("KeyG");
    expect(parseChord("5")).toBe("Digit5");
    expect(parseChord("[")).toBe("BracketLeft");
    expect(parseChord("/")).toBe("Slash");
    expect(parseChord(".")).toBe("Period");
  });

  test("modifiers are case-insensitive and normalised to a fixed order", () => {
    expect(parseChord("shift+1")).toBe("shift+Digit1");
    expect(parseChord("Shift+Ctrl+K")).toBe("ctrl+shift+KeyK");
    expect(parseChord("cmd+alt+r")).toBe("alt+meta+KeyR");
    expect(parseChord("option+meta+r")).toBe("alt+meta+KeyR");
  });

  test("'?' is shift+/ and named keys are supported", () => {
    expect(parseChord("?")).toBe("shift+Slash");
    expect(parseChord("esc")).toBe("Escape");
    expect(parseChord("f5")).toBe("F5");
    expect(parseChord("ctrl+space")).toBe("ctrl+Space");
  });

  test("unknown keys and dangling modifiers are rejected", () => {
    expect(parseChord("foo")).toBeUndefined();
    expect(parseChord("ctrl+")).toBeUndefined();
    expect(parseChord("shift")).toBeUndefined();
    expect(parseChord("a+b")).toBeUndefined();
  });
});

describe("eventChord", () => {
  test("matches the chord parsed from the config key", () => {
    expect(eventChord(key("Digit1", { shiftKey: true }))).toBe(parseChord("shift+1"));
    expect(eventChord(key("KeyR", { metaKey: true, altKey: true }))).toBe(parseChord("cmd+alt+r"));
    expect(eventChord(key("Slash", { shiftKey: true }))).toBe(parseChord("?"));
  });
});

describe("resolveHotkeys", () => {
  const find = (bindings: ReturnType<typeof resolveHotkeys>, k: string) =>
    bindings.find((b) => b.key === parseChord(k))?.action;

  test("defaults: 1-9 favorite views, shift+0 all namespaces, no shift+1-9", () => {
    const bindings = resolveHotkeys([]);
    expect(find(bindings, "1")).toEqual({ favorite: 1 });
    expect(find(bindings, "9")).toEqual({ favorite: 9 });
    expect(find(bindings, "shift+3")).toBeUndefined();
    expect(find(bindings, "v")).toEqual({ action: "pickView" });
    expect(find(bindings, "n")).toEqual({ action: "pickNamespace" });
    expect(find(bindings, "shift+0")).toEqual({ allNamespaces: true });
    expect(find(bindings, "?")).toEqual({ action: "help" });
    expect(bindings).toHaveLength(DEFAULT_HOTKEYS.length);
  });

  test("user bindings replace defaults on the same chord and add new ones", () => {
    const bindings = resolveHotkeys([
      { key: "1", action: { view: "fluxcd" } },
      { key: "g", action: { command: "flux.reconcile" } },
    ]);
    expect(find(bindings, "1")).toEqual({ view: "fluxcd" });
    expect(find(bindings, "g")).toEqual({ command: "flux.reconcile" });
    expect(bindings.find((b) => b.key === "KeyG")?.label).toBe("g");
  });

  test("action 'none' removes a default binding", () => {
    const bindings = resolveHotkeys([{ key: "e", action: { action: "none" } }]);
    expect(find(bindings, "e")).toBeUndefined();
  });

  test("bindings with an unknown key are skipped", () => {
    expect(resolveHotkeys([{ key: "nope", action: { action: "refresh" } }])).toHaveLength(DEFAULT_HOTKEYS.length);
  });
});
