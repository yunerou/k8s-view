import { afterEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { VscodeConfirmer } from "../../../../src/infra/vscode/VscodeConfirmer";

afterEach(() => vi.restoreAllMocks());
it.each([
  ["Allow", true],
  [undefined, false],
  ["Cancel", false],
] as const)("only explicit Allow approves: %s", async (answer, expected) => {
  const dialog = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(answer);
  expect(await new VscodeConfirmer().confirm("MCP action", "Host/project and variables")).toBe(expected);
  expect(dialog).toHaveBeenCalledWith("MCP action", { modal: true, detail: "Host/project and variables" }, "Allow");
});
