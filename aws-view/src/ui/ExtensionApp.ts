import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { AuthFlow } from "../app/AuthFlow";
import { AuthService } from "../app/AuthService";
import { ConnectService } from "../app/ConnectService";
import { Doctor } from "../app/Doctor";
import { IdleReminder } from "../app/IdleReminder";
import { InstanceActions } from "../app/InstanceActions";
import { InstanceService } from "../app/InstanceService";
import { InstanceSettingsStore } from "../app/InstanceSettingsStore";
import { Prompter } from "../app/ports/Prompter";
import { Selection } from "../app/Selection";
import { describeFilter } from "../core/ec2/filters";
import { errorMessage } from "../core/util/errors";
import { EXTENSION_CONTEXT, LOGGER } from "../di/tokens";
import { SdkAwsApi } from "../infra/aws/SdkAwsApi";
import { VscodeSettings } from "../infra/state/VscodeSettings";
import { registerCommands } from "./commands";
import { RemoteStatusBar } from "./RemoteStatusBar";
import { StatusBarController } from "./StatusBarController";
import { INSTANCES_VIEW_ID, InstanceTreeProvider } from "./tree/InstanceTreeProvider";
import { TagEditorPanels } from "./webview/TagEditorPanel";

/** Startup: restore the profile, register views/commands, start timers; Disposables go to context.subscriptions. */
@injectable()
export class ExtensionApp {
  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly log = inject(LOGGER),
    private readonly settings = inject(VscodeSettings),
    private readonly sdk = inject(SdkAwsApi),
    private readonly auth = inject(AuthService),
    private readonly authFlow = inject(AuthFlow),
    private readonly selection = inject(Selection),
    private readonly store = inject(InstanceSettingsStore),
    private readonly instances = inject(InstanceService),
    private readonly actions = inject(InstanceActions),
    private readonly tree = inject(InstanceTreeProvider),
    private readonly statusBar = inject(StatusBarController),
    private readonly doctor = inject(Doctor),
    private readonly connect = inject(ConnectService),
    private readonly reminder = inject(IdleReminder),
    private readonly tagEditors = inject(TagEditorPanels),
    private readonly remoteBar = inject(RemoteStatusBar),
    private readonly prompter = inject(Prompter),
  ) {}

  async start(): Promise<void> {
    const subs = this.extension.subscriptions;
    subs.push(this.log, this.settings, this.sdk, this.auth, this.selection, this.store, this.instances, this.tree);
    subs.push(this.statusBar, this.tagEditors, this.reminder, this.remoteBar);
    const view = vscode.window.createTreeView(INSTANCES_VIEW_ID, { treeDataProvider: this.tree });
    const describe = () => {
      const description = describeFilter(this.selection.filter());
      if (description === undefined) delete view.description;
      else view.description = description;
    };
    let lastListError: string | undefined;
    subs.push(
      this.instances.onDidChange(() => {
        const state = this.instances.listState();
        const error = state.kind === "ready" ? state.error : undefined;
        if (error && error !== lastListError) this.log.error(`Cannot list AWS instances: ${error}`);
        lastListError = error;
      }),
      view,
      view.onDidChangeVisibility((e) => this.instances.setVisible(e.visible)),
      this.selection.onDidChange(describe),
      ...registerCommands({
        authFlow: this.authFlow,
        instances: this.instances,
        actions: this.actions,
        selection: this.selection,
        store: this.store,
        doctor: this.doctor,
        connect: this.connect,
        reminder: this.reminder,
        tagEditors: this.tagEditors,
        prompter: this.prompter,
      }),
    );
    try {
      await this.auth.start();
    } catch (e) {
      this.log.error(`Cannot read AWS profiles: ${errorMessage(e)}`);
    }
    describe();
    this.statusBar.start();
    this.instances.setVisible(view.visible);
    void this.instances.refresh();
    this.remoteBar.start();
    this.reminder.start();
  }
}
