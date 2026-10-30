import { beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { InstanceService } from "../../../src/app/InstanceService";
import type { AwsTarget } from "../../../src/app/ports/AwsApi";
import type { Selection } from "../../../src/app/Selection";
import { TagEditorPanels } from "../../../src/ui/webview/TagEditorPanel";
import { instance } from "../helpers/aws";

const { handlers, panels } = vi.hoisted(() => ({
  handlers: [] as Map<string, (params?: unknown) => unknown>[],
  panels: [] as { reveal: ReturnType<typeof vi.fn>; dispose: () => void }[],
}));

vi.mock("vscode", async (original) => {
  const actual = await original<typeof import("vscode")>();
  return {
    ...actual,
    window: {
      ...actual.window,
      createWebviewPanel: () => {
        const callbacks: (() => void)[] = [];
        const panel = {
          webview: { html: "", cspSource: "csp", asWebviewUri: (uri: unknown) => uri },
          onDidDispose: (callback: () => void) => {
            callbacks.push(callback);
            return { dispose() {} };
          },
          reveal: vi.fn(),
          dispose: () => {
            for (const callback of callbacks) callback();
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
});

vi.mock("vscode-messenger", () => ({
  Messenger: class {
    private readonly requests = new Map<string, (params?: unknown) => unknown>();
    constructor() {
      handlers.push(this.requests);
    }
    registerWebviewPanel() {}
    onRequest(type: { method: string }, handler: (params?: unknown) => unknown) {
      this.requests.set(type.method, handler);
      return { dispose() {} };
    }
  },
}));

beforeEach(() => {
  handlers.length = 0;
  panels.length = 0;
});

describe("TagEditorPanels", () => {
  test.each(["profile", "region"] as const)(
    "rejects saves after %s changes, even if the instance ID collides",
    async (field) => {
      let target: AwsTarget = { profile: "dev", region: "eu-west-1" };
      const original = instance({ id: "i-1", tags: { Name: "original" } });
      const saveTags = vi.fn();
      const get = vi.fn(() => original);
      const service = { get, saveTags } as unknown as InstanceService;
      const selection = { target: () => target } as Selection;
      const context = { extensionUri: vscode.Uri.file("/ext") } as vscode.ExtensionContext;
      const editor = new TagEditorPanels(context, service, selection);
      editor.open(original);
      editor.open(original);
      expect(panels).toHaveLength(1);
      expect(panels[0]?.reveal).toHaveBeenCalledOnce();

      target = { ...target, [field]: "other" };
      get.mockReturnValue(instance({ id: "i-1", tags: { Name: "different account" } }));
      expect(await handlers[0]?.get("tags/save")?.({ rows: [{ key: "Name", value: "edited" }] })).toEqual({
        error: "The AWS profile or region changed. Reopen the tag editor for the selected instance.",
      });
      expect(saveTags).not.toHaveBeenCalled();
      expect(handlers[0]?.get("tags/getInit")?.()).toMatchObject({ rows: [{ key: "Name", value: "original" }] });
      editor.open(original);
      expect(panels).toHaveLength(2);
      editor.dispose();
    },
  );
});
