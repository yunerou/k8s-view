import * as vscode from "vscode";
import type { AuthFlow } from "../app/AuthFlow";
import type { ConnectService } from "../app/ConnectService";
import type { Doctor } from "../app/Doctor";
import { editFilter, pickRegion } from "../app/filterFlow";
import type { IdleReminder } from "../app/IdleReminder";
import type { InstanceActions } from "../app/InstanceActions";
import type { InstanceService } from "../app/InstanceService";
import type { InstanceSettingsStore } from "../app/InstanceSettingsStore";
import type { Prompter } from "../app/ports/Prompter";
import type { Selection } from "../app/Selection";
import type { TreeNode } from "./tree/TreeNode";
import type { TagEditorPanels } from "./webview/TagEditorPanel";

export interface CommandDeps {
  readonly tagEditors: TagEditorPanels;
  readonly reminder: IdleReminder;
  readonly connect: ConnectService;
  readonly doctor: Doctor;
  readonly authFlow: AuthFlow;
  readonly instances: InstanceService;
  readonly actions: InstanceActions;
  readonly selection: Selection;
  readonly store: InstanceSettingsStore;
  readonly prompter: Prompter;
}

export type InstanceNode = Extract<TreeNode, { type: "instance" }>;

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand.bind(vscode.commands);
  return [
    reg("awsView.runDoctor", () => d.doctor.report()),
    reg("awsView.openRemote", (n: InstanceNode) => d.connect.openRemote(n.instance)),
    reg("awsView.openTerminal", (n: InstanceNode) => d.connect.openTerminal(n.instance)),
    reg("awsView.setSshUser", (n: InstanceNode) => d.connect.setSshUser(n.instance)),
    reg("awsView.setFallbackKey", (n: InstanceNode) => d.connect.setFallbackKey(n.instance)),
    reg("awsView.rename", (n: InstanceNode) => d.actions.rename(n.instance)),
    reg("awsView.editTags", (n: InstanceNode) => d.tagEditors.open(n.instance)),
    reg("awsView.remoteActions", () => d.reminder.promptActions()),

    reg("awsView.selectProfile", () => d.authFlow.selectProfile()),
    reg("awsView.signIn", () => d.authFlow.signIn()),
    reg("awsView.signOut", () => d.authFlow.signOut()),
    reg("awsView.selectRegion", () => pickRegion(d.prompter, d.selection)),
    reg("awsView.refresh", () => d.instances.refresh()),
    reg("awsView.filter", () => editFilter(d.prompter, d.selection)),
    reg("awsView.togglePinnedOnly", () => {
      const f = d.selection.filter();
      return d.selection.setFilter({ ...f, pinnedOnly: !f.pinnedOnly });
    }),
    reg("awsView.clearFilter", () => d.selection.clearFilter()),
    reg("awsView.start", (n: InstanceNode) => d.actions.start(n.instance)),
    reg("awsView.stop", (n: InstanceNode) => d.actions.stop(n.instance)),
    reg("awsView.pin", (n: InstanceNode) => d.store.update(n.instance.id, { pinned: true })),
    reg("awsView.unpin", (n: InstanceNode) => d.store.update(n.instance.id, { pinned: false })),
    reg("awsView.copyInstanceId", (n: InstanceNode) => vscode.env.clipboard.writeText(n.instance.id)),
  ];
}
