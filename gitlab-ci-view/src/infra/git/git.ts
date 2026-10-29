import type * as vscode from "vscode";

export interface GitExtension {
  getAPI(version: 1): GitApi;
}

export interface GitApi {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

export interface RepositoryState {
  readonly HEAD: { readonly name?: string } | undefined;
  readonly remotes: readonly { readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }[];
  readonly onDidChange: vscode.Event<void>;
}
