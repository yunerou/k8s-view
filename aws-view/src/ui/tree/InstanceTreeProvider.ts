import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { InstanceService } from "../../app/InstanceService";
import { InstanceSettingsStore } from "../../app/InstanceSettingsStore";
import { type Instance, instanceLabel, uptimeMs } from "../../core/ec2/model";
import type { Disposable } from "../../core/util/Emitter";
import { formatDuration } from "../../core/util/format";
import { instanceIcon } from "../icons";
import { contextValue, type TreeNode } from "./TreeNode";

export const INSTANCES_VIEW_ID = "awsView.instances";

function message(key: string, text: string, icon: string, command?: string): TreeNode {
  return command
    ? { type: "message", key, text, icon, command: { command, title: text } }
    : { type: "message", key, text, icon };
}

function ssmText(i: Instance): string {
  if (i.state !== "running") return "";
  if (i.ssm === "Online") return "SSM online";
  return i.ssm ? `SSM ${i.ssm}` : "SSM not connected";
}

/** Instances of the selected profile/region; pinned instances first. */
@injectable()
export class InstanceTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: Disposable[];

  constructor(
    private readonly instances = inject(InstanceService),
    private readonly store = inject(InstanceSettingsStore),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.subs = [instances.onDidChange(() => this.changed.fire(undefined))];
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return [];
    const s = this.instances.listState();
    switch (s.kind) {
      case "noProfile":
        return [message("noProfile", "Select an AWS profile", "account", "awsView.selectProfile")];
      case "noRegion":
        return [message("noRegion", "Select a region", "globe", "awsView.selectRegion")];
      case "signedOut":
        return [message("signedOut", `Sign in to ${s.profile}`, "key", "awsView.signIn")];
      case "loading":
        return [message("loading", "Loading instances…", "loading~spin")];
      case "ready": {
        const pinned = this.store.pinned();
        const nodes: TreeNode[] = [...s.instances]
          .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)))
          .map((instance) => ({ type: "instance", instance, pinned: pinned.has(instance.id) }));
        if (s.error) nodes.unshift(message("error", s.error, "error", "awsView.refresh"));
        else if (nodes.length === 0) nodes.push(message("empty", "No instances match the filter", "info"));
        return nodes;
      }
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === "message") {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.id = node.key;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) item.command = { ...node.command, arguments: [...(node.command.arguments ?? [])] };
      return item;
    }
    const i = node.instance;
    const item = new vscode.TreeItem(instanceLabel(i), vscode.TreeItemCollapsibleState.None);
    item.id = `instance:${i.id}`;
    item.description = [i.type, i.state, ssmText(i)].filter(Boolean).join(" · ");
    item.iconPath = instanceIcon(i);
    item.contextValue = contextValue(i, node.pinned);
    const up = uptimeMs(i, this.now());
    const tags = Object.entries(i.tags)
      .filter(([k]) => k !== "Name")
      .map(([k, v]) => `\`${k}\` = ${v}`);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${instanceLabel(i)}** \`${i.id}\`${node.pinned ? " (pinned)" : ""}`,
        [i.type, i.state, ssmText(i)].filter(Boolean).join(" · "),
        ...(up !== undefined ? [`Running for ${formatDuration(up)}`] : []),
        ...(tags.length > 0 ? [tags.join("  \n")] : []),
      ].join("\n\n"),
    );
    return item;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
