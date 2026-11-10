import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveRepo, rootPath } from "../../../../src/app/mcp/repoResolver";
import { repoRef } from "../../helpers/gitlab";

const repo = (path: string, name = "demo", host = "gitlab.com") =>
  repoRef({ id: pathToFileURL(path).href, name, host, projectPath: `team/${name}` });
it("resolves names and project paths case-insensitively, with explicit ambiguity", () => {
  const a = repo("/ws/a", "Alpha");
  const b = repo("/ws/b", "Beta");
  expect(resolveRepo([a, b], { repo: "TEAM/ALPHA" })).toBe(a);
  expect(() => resolveRepo([a, repo("/ws/c", "Alpha", "other.host")], { repo: "alpha" })).toThrow("Ambiguous");
  expect(() => resolveRepo([a, b], { repo: "missing" })).toThrow(/Available:.*Alpha.*Beta/);
});
it("uses the deepest containing file URI, preserving case and decoding Unicode/spaces", () => {
  const a = repo("/ws/Việt Nam");
  const b = repo("/ws/Việt Nam/child");
  expect(rootPath(a)).toBe("/ws/Việt Nam");
  expect(resolveRepo([a, b], { cwd: "/ws/Việt Nam/child/src" })).toBe(b);
  expect(() => resolveRepo([a, b], { cwd: "/ws/Việt Nam-other" })).toThrow("pass repo");
  expect(() => resolveRepo([a, b], { cwd: "/ws/việt nam" })).toThrow("pass repo");
});
it("falls back only for one repo and rejects tied roots and empty registries", () => {
  const a = repo("/ws/a");
  expect(resolveRepo([a], { cwd: "/elsewhere" })).toBe(a);
  expect(() => resolveRepo([], {})).toThrow("none");
  expect(() => resolveRepo([a, { ...a }], { cwd: "/ws/a" })).toThrow("Ambiguous");
});
