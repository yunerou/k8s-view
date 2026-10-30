import { Container } from "@needle-di/core";
import * as vscode from "vscode";
import { AuthService } from "./app/AuthService";
import { InstanceService } from "./app/InstanceService";
import { InstanceSettingsStore } from "./app/InstanceSettingsStore";
import { AwsApi } from "./app/ports/AwsApi";
import { AwsAuthApi } from "./app/ports/AwsAuthApi";
import { AwsConfigSource } from "./app/ports/AwsConfigSource";
import { CredentialFile } from "./app/ports/CredentialFile";
import { Notifier } from "./app/ports/Notifier";
import { Prompter } from "./app/ports/Prompter";
import { Runner } from "./app/ports/Runner";
import { Settings } from "./app/ports/Settings";
import { SshConfigStore } from "./app/ports/SshConfigStore";
import { StateStore } from "./app/ports/StateStore";
import { Workbench } from "./app/ports/Workbench";
import { Selection } from "./app/Selection";
import { EXTENSION_CONTEXT, LOGGER } from "./di/tokens";
import { FileAwsConfigSource } from "./infra/aws/FileAwsConfigSource";
import { FileCredentialFile } from "./infra/aws/FileCredentialFile";
import { SdkAuthApi } from "./infra/aws/SdkAuthApi";
import { SdkAwsApi } from "./infra/aws/SdkAwsApi";
import { NodeRunner } from "./infra/process/NodeRunner";
import { FileSshConfigStore } from "./infra/ssh/FileSshConfigStore";
import { VscodeSettings } from "./infra/state/VscodeSettings";
import { VscodeStateStore } from "./infra/state/VscodeStateStore";
import { VscodeNotifier } from "./infra/vscode/VscodeNotifier";
import { VscodePrompter } from "./infra/vscode/VscodePrompter";
import { VscodeWorkbench } from "./infra/vscode/VscodeWorkbench";
import { ExtensionApp } from "./ui/ExtensionApp";
import { InstanceTreeProvider } from "./ui/tree/InstanceTreeProvider";

/** Internal API returned only during integration tests (`AWS_VIEW_INTEGRATION=1`). */
export interface TestApi {
  readonly auth: AuthService;
  readonly aws: AwsApi;
  readonly instances: InstanceService;
  readonly selection: Selection;
  readonly store: InstanceSettingsStore;
  readonly tree: InstanceTreeProvider;
}

/** Single composition root: port → adapter (`useExisting` makes the port and adapter share one instance). */
export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const container = new Container()
    .bind({ provide: EXTENSION_CONTEXT, useValue: context })
    .bind({ provide: LOGGER, useValue: vscode.window.createOutputChannel("AWS View", { log: true }) })
    .bind({ provide: Settings, useExisting: VscodeSettings })
    .bind({ provide: StateStore, useExisting: VscodeStateStore })
    .bind({ provide: Prompter, useExisting: VscodePrompter })
    .bind({ provide: Notifier, useExisting: VscodeNotifier })
    .bind({ provide: Runner, useExisting: NodeRunner })
    .bind({ provide: AwsConfigSource, useExisting: FileAwsConfigSource })
    .bind({ provide: CredentialFile, useExisting: FileCredentialFile })
    .bind({ provide: AwsAuthApi, useExisting: SdkAuthApi })
    .bind({ provide: AwsApi, useExisting: SdkAwsApi })
    .bind({ provide: Workbench, useExisting: VscodeWorkbench })
    .bind({ provide: SshConfigStore, useExisting: FileSshConfigStore });
  await container.get(ExtensionApp).start();
  if (process.env["AWS_VIEW_INTEGRATION"] !== "1") return undefined;
  return {
    auth: container.get(AuthService),
    aws: container.get(AwsApi),
    instances: container.get(InstanceService),
    selection: container.get(Selection),
    store: container.get(InstanceSettingsStore),
    tree: container.get(InstanceTreeProvider),
  };
}

export function deactivate(): void {}
