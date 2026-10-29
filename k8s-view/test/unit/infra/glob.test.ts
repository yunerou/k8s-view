import { describe, expect, test } from "vitest";
import { splitGlob } from "../../../src/infra/config/glob";

describe("splitGlob", () => {
  test("expands ~ and splits directory from the file pattern", () => {
    const g = splitGlob("~/.config/k8s-view/*.json", "/home/u");
    expect(g.dir).toBe("/home/u/.config/k8s-view");
    expect(g.matches("a.json")).toBe(true);
    expect(g.matches("a.jsonc")).toBe(false);
    expect(g.matches(".hidden.json")).toBe(true);
  });

  test("plain file path matches only that file", () => {
    const g = splitGlob("/etc/k8s-view/team.json", "/home/u");
    expect(g.dir).toBe("/etc/k8s-view");
    expect(g.matches("team.json")).toBe(true);
    expect(g.matches("other.json")).toBe(false);
  });

  test("? and character escaping", () => {
    const g = splitGlob("/x/view-?.json", "/h");
    expect(g.matches("view-1.json")).toBe(true);
    expect(g.matches("view-12.json")).toBe(false);
    expect(g.matches("viewx1.json")).toBe(false);
  });

  test("windows separators", () => {
    const g = splitGlob("C:\\cfg\\k8s-view\\*.json", "C:\\Users\\u");
    expect(g.dir).toBe("C:\\cfg\\k8s-view");
    expect(g.matches("a.json")).toBe(true);
  });
});
