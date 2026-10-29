import { describe, expect, test } from "vitest";
import { EventEmitter, type MarkdownString, TreeItemCollapsibleState } from "vscode";
import { CommandRegistry } from "../../../src/app/CommandRegistry";
import type { ContextService } from "../../../src/app/ContextService";
import type { LoadedConfigFile } from "../../../src/app/ports/ConfigSource";
import type { ConfigOrigin } from "../../../src/core/config/origin";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import { SnippetTreeProvider } from "../../../src/ui/tree/SnippetTreeProvider";

const file = (id: string, origin: ConfigOrigin, commands: object[]): LoadedConfigFile => ({
  id,
  origin,
  parsed: parseConfigText(JSON.stringify({ version: 1, commands })),
});

const snippet = (id: string, extra: object = {}) => ({
  id,
  title: id.toUpperCase(),
  target: "namespace",
  run: { type: "terminal", command: "kubectl", args: ["get", "pods", "-l", "app=${input:app}"] },
  ...extra,
});

function setup(files: LoadedConfigFile[]) {
  const commands = new CommandRegistry();
  commands.apply(files, { trusted: true, isPresetActive: () => true }, new Map());
  const contexts = { onDidChange: new EventEmitter<unknown>().event } as unknown as ContextService;
  return { commands, provider: new SnippetTreeProvider(commands, contexts) };
}

describe("SnippetTreeProvider", () => {
  test("flat list for one group; groups when several; resource commands excluded", () => {
    const flat = setup([
      file("builtin://c", "builtin", [
        snippet("a"),
        { id: "res", title: "Res", match: [{ kind: "Pod" }], run: { type: "kubectl", args: [] } },
      ]),
    ]);
    expect(flat.provider.getChildren()).toEqual([{ type: "snippet", id: "a" }]);

    const grouped = setup([
      file("builtin://c", "builtin", [snippet("a", { group: "Cluster" }), snippet("b", { group: "Debug" })]),
    ]);
    const roots = grouped.provider.getChildren();
    expect(roots).toEqual([
      { type: "group", group: "Cluster" },
      { type: "group", group: "Debug" },
    ]);
    expect(grouped.provider.getTreeItem(roots[0]!).collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(grouped.provider.getChildren(roots[1])).toEqual([{ type: "snippet", id: "b" }]);
  });

  test("item: click runs, params in description, origin in contextValue, command line in tooltip", () => {
    const { provider } = setup([
      file("file:///home/u/.config/k8s-view/snippets.json", "user", [
        snippet("pods", { inputs: [{ id: "app", type: "prompt", title: "App" }], icon: "search" }),
        snippet("nodes", { target: "context", run: { type: "terminal", command: "kubectl", args: ["get", "nodes"] } }),
      ]),
    ]);
    const item = provider.getTreeItem({ type: "snippet", id: "pods" });
    expect(item.label).toBe("PODS");
    expect(item.description).toBe("namespace · app");
    expect(item.contextValue).toBe("k8sview.snippet:user");
    expect(item.command).toEqual({
      command: "k8sView.runSnippetItem",
      title: "Run",
      arguments: [{ type: "snippet", id: "pods" }],
    });
    const tooltip = (item.tooltip as MarkdownString).value;
    expect(tooltip).toContain("kubectl get pods -l app=${input:app}");
    expect(tooltip).toContain("`app` — App (prompt)");
    expect(tooltip).toContain("user config");
    expect(provider.getTreeItem({ type: "snippet", id: "nodes" }).description).toBe("context");
  });
});
