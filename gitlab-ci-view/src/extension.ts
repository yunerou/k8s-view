import { Container } from "@needle-di/core";
import * as vscode from "vscode";
import { PipelineService } from "./app/PipelineService";
import { GitLabApi } from "./app/ports/GitLabApi";
import { Notifier } from "./app/ports/Notifier";
import { Prompter } from "./app/ports/Prompter";
import { RepoSource } from "./app/ports/RepoSource";
import { SecretStore } from "./app/ports/SecretStore";
import { Settings } from "./app/ports/Settings";
import { StateStore } from "./app/ports/StateStore";
import { RepoRegistry } from "./app/RepoRegistry";
import { RepoSelection } from "./app/RepoSelection";
import { TokenStore } from "./app/TokenStore";
import { EXTENSION_CONTEXT, LOGGER } from "./di/tokens";
import { VscodeRepoSource } from "./infra/git/VscodeRepoSource";
import { GitLabHttp } from "./infra/gitlab/GitLabHttp";
import { VscodeSecretStore } from "./infra/state/VscodeSecretStore";
import { VscodeSettings } from "./infra/state/VscodeSettings";
import { VscodeStateStore } from "./infra/state/VscodeStateStore";
import { VscodeNotifier } from "./infra/vscode/VscodeNotifier";
import { VscodePrompter } from "./infra/vscode/VscodePrompter";
import { ExtensionApp } from "./ui/ExtensionApp";
import { PipelineTreeProvider } from "./ui/tree/PipelineTreeProvider";

/** Internal API returned only during integration tests (`GITLAB_CI_VIEW_INTEGRATION=1`). */
export interface TestApi {
  readonly pipelines: PipelineService;
  readonly repos: RepoRegistry;
  readonly selection: RepoSelection;
  readonly tokens: TokenStore;
  readonly tree: PipelineTreeProvider;
}

/** Single composition root: port → adapter (`useExisting` makes the port and adapter share one instance). */
export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const container = new Container()
    .bind({ provide: EXTENSION_CONTEXT, useValue: context })
    .bind({ provide: LOGGER, useValue: vscode.window.createOutputChannel("GitLab CI View", { log: true }) })
    .bind({ provide: Settings, useExisting: VscodeSettings })
    .bind({ provide: StateStore, useExisting: VscodeStateStore })
    .bind({ provide: SecretStore, useExisting: VscodeSecretStore })
    .bind({ provide: GitLabApi, useExisting: GitLabHttp })
    .bind({ provide: RepoSource, useExisting: VscodeRepoSource })
    .bind({ provide: Prompter, useExisting: VscodePrompter })
    .bind({ provide: Notifier, useExisting: VscodeNotifier });
  await container.get(ExtensionApp).start();
  if (process.env["GITLAB_CI_VIEW_INTEGRATION"] !== "1") return undefined;
  return {
    pipelines: container.get(PipelineService),
    repos: container.get(RepoRegistry),
    selection: container.get(RepoSelection),
    tokens: container.get(TokenStore),
    tree: container.get(PipelineTreeProvider),
  };
}

export function deactivate(): void {}
