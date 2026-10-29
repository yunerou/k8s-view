import { Container } from "@needle-di/core";
import * as vscode from "vscode";
import { CommandExecutor } from "./app/CommandExecutor";
import { CommandRegistry } from "./app/CommandRegistry";
import { ContextService } from "./app/ContextService";
import { ExtensionApp } from "./app/ExtensionApp";
import { ClusterApi } from "./app/ports/ClusterApi";
import { ConfigSource } from "./app/ports/ConfigSource";
import { KubeConfigSource } from "./app/ports/KubeConfigSource";
import { LogSource } from "./app/ports/LogSource";
import { Prompter } from "./app/ports/Prompter";
import { ResourceSource } from "./app/ports/ResourceSource";
import {
  BatchRunner,
  CommandInvoker,
  KubectlRunner,
  ProcessRunner,
  TerminalRunner,
  WorkspaceInfo,
} from "./app/ports/Runners";
import { Settings } from "./app/ports/Settings";
import { StateStore } from "./app/ports/StateStore";
import { ViewRegistry } from "./app/ViewRegistry";
import { ViewSessionManager } from "./app/ViewSessionManager";
import { EXTENSION_CONTEXT, LOGGER } from "./di/tokens";
import { ConfigLoader } from "./infra/config/ConfigLoader";
import { MsKubectlRunner } from "./infra/exec/MsKubectlRunner";
import { NodeProcessRunner } from "./infra/exec/NodeProcessRunner";
import { VscodeCommandInvoker } from "./infra/exec/VscodeCommandInvoker";
import { VscodeTerminalRunner } from "./infra/exec/VscodeTerminalRunner";
import { KubeBatchRunner } from "./infra/kube/KubeBatchRunner";
import { KubeClusterApi } from "./infra/kube/KubeClusterApi";
import { KubeConfigAccess } from "./infra/kube/KubeConfigAccess";
import { KubeConfigProvider } from "./infra/kube/KubeConfigProvider";
import { KubeHttp } from "./infra/kube/KubeHttp";
import { KubeLogSource } from "./infra/kube/KubeLogSource";
import { KubeResourceSource } from "./infra/kube/KubeResourceSource";
import { KubeTransport } from "./infra/kube/KubeTransport";
import { VscodeSettings } from "./infra/state/VscodeSettings";
import { VscodeStateStore } from "./infra/state/VscodeStateStore";
import { VscodeWorkspaceInfo } from "./infra/state/VscodeWorkspaceInfo";
import { VscodePrompter } from "./ui/VscodePrompter";

/** Internal API returned only during integration tests (`K8S_VIEW_INTEGRATION=1`). */
export interface TestApi {
  readonly contexts: ContextService;
  readonly views: ViewRegistry;
  readonly sessions: ViewSessionManager;
  readonly commands: CommandRegistry;
  readonly executor: CommandExecutor;
  readonly source: ResourceSource;
}

/**
 * Single composition root: port → adapter. Adapters are `@injectable()`, so needle-di automatically binds them to their parent class (port);
 * `useExisting` bindings explicitly associate port → adapter without creating a second provider.
 */
export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const container = new Container()
    .bind({ provide: EXTENSION_CONTEXT, useValue: context })
    .bind({ provide: LOGGER, useValue: vscode.window.createOutputChannel("K8s View", { log: true }) })
    .bind({ provide: Settings, useExisting: VscodeSettings })
    .bind({ provide: StateStore, useExisting: VscodeStateStore })
    .bind({ provide: KubeConfigSource, useExisting: KubeConfigProvider })
    .bind({ provide: KubeConfigAccess, useExisting: KubeConfigProvider })
    .bind({ provide: KubeTransport, useExisting: KubeHttp })
    .bind({ provide: ClusterApi, useExisting: KubeClusterApi })
    .bind({ provide: ResourceSource, useExisting: KubeResourceSource })
    .bind({ provide: LogSource, useExisting: KubeLogSource })
    .bind({ provide: ConfigSource, useExisting: ConfigLoader })
    .bind({ provide: Prompter, useExisting: VscodePrompter })
    .bind({ provide: BatchRunner, useExisting: KubeBatchRunner })
    .bind({ provide: ProcessRunner, useExisting: NodeProcessRunner })
    .bind({ provide: TerminalRunner, useExisting: VscodeTerminalRunner })
    .bind({ provide: KubectlRunner, useExisting: MsKubectlRunner })
    .bind({ provide: CommandInvoker, useExisting: VscodeCommandInvoker })
    .bind({ provide: WorkspaceInfo, useExisting: VscodeWorkspaceInfo });
  await container.get(ExtensionApp).start();
  if (process.env["K8S_VIEW_INTEGRATION"] !== "1") return undefined;
  return {
    contexts: container.get(ContextService),
    views: container.get(ViewRegistry),
    sessions: container.get(ViewSessionManager),
    commands: container.get(CommandRegistry),
    executor: container.get(CommandExecutor),
    source: container.get(ResourceSource),
  };
}

export function deactivate(): void {}
