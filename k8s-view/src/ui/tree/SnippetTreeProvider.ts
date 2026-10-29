import * as vscode from "vscode";
import type { CommandRegistry } from "../../app/CommandRegistry";
import type { ContextService } from "../../app/ContextService";
import type { CommandDefinition } from "../../core/command/CommandDefinition";

export const SNIPPET_VIEW_ID = "k8sView.snippets";
export const SNIPPET_CONTEXT_PREFIX = "k8sview.snippet:";

export type SnippetNode =
  | { readonly type: "group"; readonly group: string }
  | { readonly type: "snippet"; readonly id: string };

const DEFAULT_GROUP = "Snippets";
const ORIGIN_LABEL: Record<string, string> = {
  builtin: "built-in",
  preset: "preset",
  remote: "remote config",
  user: "user config",
  workspace: "workspace config",
};

/**
 * Sidebar "Snippets" section: commands without resource targets (`target: namespace | context`), grouped by `group`.
 * Click to run; `${input:…}` parameters are prompted at execution time (previous values are suggested).
 */
export class SnippetTreeProvider implements vscode.TreeDataProvider<SnippetNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SnippetNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly commands: CommandRegistry,
    contexts: ContextService,
  ) {
    this.subscriptions = [
      commands.onDidChange(() => this.changed.fire(undefined)),
      contexts.onDidChange(() => this.changed.fire(undefined)),
    ];
  }

  getChildren(node?: SnippetNode): SnippetNode[] {
    const snippets = this.commands.snippets();
    if (node?.type === "snippet") return [];
    if (node?.type === "group")
      return snippets.filter((c) => groupOf(c) === node.group).map((c) => ({ type: "snippet", id: c.id }));
    const groups = [...new Set(snippets.map(groupOf))];
    // Only one group: use a flat list for brevity.
    if (groups.length <= 1) return snippets.map((c) => ({ type: "snippet", id: c.id }));
    return groups.map((group) => ({ type: "group", group }));
  }

  getTreeItem(node: SnippetNode): vscode.TreeItem {
    if (node.type === "group") {
      const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group}`;
      item.iconPath = new vscode.ThemeIcon("symbol-folder");
      item.contextValue = "k8sview.snippetGroup";
      return item;
    }
    const command = this.commands.get(node.id);
    const item = new vscode.TreeItem(command?.title ?? node.id, vscode.TreeItemCollapsibleState.None);
    item.id = `snippet:${node.id}`;
    if (!command) return item;
    const params = command.inputs.map((i) => i.config.id);
    item.description = [command.target === "context" ? "context" : "namespace", params.join(", ")]
      .filter(Boolean)
      .join(" · ");
    item.iconPath = new vscode.ThemeIcon(command.icon ?? "terminal");
    item.contextValue = `${SNIPPET_CONTEXT_PREFIX}${command.origin}`;
    item.tooltip = tooltip(command, this.commands.locationOf(command.id)?.fileId);
    item.command = { command: "k8sView.runSnippetItem", title: vscode.l10n.t("Run"), arguments: [node] };
    item.accessibilityInformation = {
      label: vscode.l10n.t("Snippet {0}, runs on the current {1}", command.title, command.target ?? "namespace"),
    };
    return item;
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.changed.dispose();
  }
}

function groupOf(c: CommandDefinition): string {
  return c.group ?? DEFAULT_GROUP;
}

/** Command line (before template rendering) for tooltip previews. */
export function commandLinePreview(c: CommandDefinition): string {
  const run = c.config.run;
  const quote = (a: string) => (/^[^\s'"]+$/.test(a) ? a : JSON.stringify(a));
  switch (run.type) {
    case "batch":
      return `Batch ${run.operation}`;
    case "vscode":
      return `${run.command} ${JSON.stringify(run.args)}`;
    case "kubectl":
      return ["kubectl", ...run.args].map(quote).join(" ");
    default:
      return [run.command, ...run.args].map(quote).join(" ");
  }
}

function tooltip(c: CommandDefinition, fileId: string | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.appendMarkdown(`**${c.title}**\n\n`);
  md.appendCodeblock(commandLinePreview(c), "shell");
  md.appendMarkdown(
    `\nRuns on the current **${c.target === "context" ? "context" : "namespace"}**` +
      ` · ${c.config.run.type === "process" ? "in the background" : c.config.run.type}` +
      `${c.dangerous ? " · dangerous" : ""}\n\n`,
  );
  if (c.inputs.length > 0) {
    md.appendMarkdown("Parameters:\n");
    for (const i of c.inputs) md.appendMarkdown(`- \`${i.config.id}\` — ${i.config.title} (${i.config.type})\n`);
    md.appendMarkdown("\n");
  }
  const where = fileId && (c.origin === "user" || c.origin === "workspace") ? vscode.Uri.parse(fileId).fsPath : "";
  md.appendMarkdown(`Source: ${ORIGIN_LABEL[c.origin] ?? c.origin}${where ? ` — \`${where}\`` : ""}`);
  return md;
}
