import { describe, expect, test } from "vitest";
import { parseConfigText } from "../../../src/core/config/parseConfig";

const at = (text: string, needle: string) => text.indexOf(needle);

describe("parseConfigText", () => {
  test("parses JSONC with comments and returns validated entries", () => {
    const text = `{
      // comment
      "version": 1,
      "views": [{ "id": "a", "title": "A", "sections": [{ "id": "s", "title": "S", "resources": [{ "kind": "Pod" }] }] }],
      "commands": [{ "extends": "pod.logs", "dangerous": true }]
    }`;
    const r = parseConfigText(text);
    expect(r.issues).toEqual([]);
    expect(r.views).toHaveLength(1);
    expect(r.views[0]!.config).toMatchObject({ id: "a", enabled: true });
    expect(r.views[0]!.index).toBe(0);
    expect(r.commands[0]!.config).toMatchObject({ extends: "pod.logs", dangerous: true });
  });

  test("reports syntax errors with offsets", () => {
    const text = `{ "version": 1, "views": [ }`;
    const r = parseConfigText(text);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0]!.offset).toBe(at(text, "}"));
    expect(r.views).toEqual([]);
  });

  test("maps zod issues to the offending node and keeps valid siblings", () => {
    const text = `{"version": 1, "views": [
      {"id": "bad", "titel": "x", "title": "B", "sections": [{"id": "s", "title": "S", "resources": [{"kind": "Pod"}]}]},
      {"id": "good", "title": "G", "sections": [{"id": "s", "title": "S", "resources": [{"kind": "Pod"}]}]}
    ]}`;
    const r = parseConfigText(text);
    expect(r.views.map((v) => (v.config as { id: string }).id)).toEqual(["good"]);
    expect(r.views[0]!.index).toBe(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toMatch(/titel/);
    expect(r.issues[0]!.offset).toBe(at(text, '"titel"'));
  });

  test("points nested errors at the value node", () => {
    const text = `{"version": 1, "views": [{"id": "v", "title": "V", "sections": [{"id": "s", "title": "S", "resources": [{"kind": "Pod"}], "columns": [{"title": "X", "path": "$.a", "render": "fancy"}]}]}]}`;
    const r = parseConfigText(text);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.path).toEqual(["views", 0, "sections", 0, "columns", 0]);
    expect(r.views).toEqual([]);
  });

  test("reports wrong version on the version node", () => {
    const text = `{"version": 2}`;
    const r = parseConfigText(text);
    expect(r.issues[0]!.offset).toBe(at(text, "2"));
  });

  test("empty file is an error", () => {
    expect(parseConfigText("").issues[0]!.message).toMatch(/empty/i);
  });

  test("parses hotkey bindings in the flat config form", () => {
    const r = parseConfigText(`{"version": 1, "hotkeys": {
      "bindings": [
        {"key": "g", "command": "flux.reconcile"},
        {"key": "5", "view": "fluxcd"},
        {"key": "shift+r", "action": "refresh"},
        {"key": "ctrl+1", "namespace": "kube-system"},
        {"key": "ctrl+2", "favorite": 2}
      ]
    }}`);
    expect(r.issues).toEqual([]);
    expect(r.hotkeys).toEqual({
      bindings: [
        { key: "g", action: { command: "flux.reconcile" } },
        { key: "5", action: { view: "fluxcd" } },
        { key: "shift+r", action: { action: "refresh" } },
        { key: "ctrl+1", action: { namespace: "kube-system" } },
        { key: "ctrl+2", action: { favorite: 2 } },
      ],
    });
  });

  test("a bad hotkey binding is reported and skipped, its siblings are kept", () => {
    const text = `{"version": 1, "hotkeys": {"bindings": [
      {"key": "hyper+x", "action": "refresh"},
      {"key": "g", "command": "a", "view": "b"},
      {"key": "x", "action": "explode"},
      {"key": "y", "favorite": 10},
      {"key": "r", "action": "refresh"}
    ]}}`;
    const r = parseConfigText(text);
    expect(r.hotkeys?.bindings).toEqual([{ key: "r", action: { action: "refresh" } }]);
    expect(r.issues.map((i) => i.path)).toEqual([
      ["hotkeys", "bindings", 0, "key"],
      ["hotkeys", "bindings", 1],
      ["hotkeys", "bindings", 2, "action"],
      ["hotkeys", "bindings", 3, "favorite"],
    ]);
    expect(r.issues[0]!.message).toMatch(/Unknown key/);
  });
});
