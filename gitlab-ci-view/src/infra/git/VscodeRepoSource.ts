import { posix } from "node:path";
import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type GitRepoInfo, RepoSource } from "../../app/ports/RepoSource";
import { Emitter } from "../../core/util/Emitter";
import { LOGGER } from "../../di/tokens";
import type { GitApi, GitExtension, Repository } from "./git";

/** Repositories from the `vscode.git` extension; fires events when repositories open/close or HEAD/remotes change. */
@injectable()
export class VscodeRepoSource extends RepoSource implements vscode.Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private api: GitApi | undefined;
  private readonly repoSubs = new Map<string, vscode.Disposable>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly log = inject(LOGGER)) {
    super();
  }

  async initialize(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) {
      this.log.warn("The built-in Git extension is not available; no repository can be detected.");
      return;
    }
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    this.api = api;
    this.subs.push(
      api.onDidOpenRepository((r) => {
        this.watch(r);
        this.changed.fire();
      }),
      api.onDidCloseRepository((r) => {
        const key = r.rootUri.toString();
        this.repoSubs.get(key)?.dispose();
        this.repoSubs.delete(key);
        this.changed.fire();
      }),
    );
    for (const r of api.repositories) this.watch(r);
    this.changed.fire();
  }

  repositories(): readonly GitRepoInfo[] {
    return (this.api?.repositories ?? []).map((r) => ({
      rootUri: r.rootUri.toString(),
      name: posix.basename(r.rootUri.path),
      remotes: r.state.remotes.map((m) => ({ name: m.name, fetchUrl: m.fetchUrl, pushUrl: m.pushUrl })),
      branch: r.state.HEAD?.name,
    }));
  }

  dispose(): void {
    for (const d of [...this.subs, ...this.repoSubs.values()]) d.dispose();
    this.repoSubs.clear();
    this.changed.dispose();
  }

  private watch(repo: Repository): void {
    const key = repo.rootUri.toString();
    if (this.repoSubs.has(key)) return;
    // state.onDidChange also fires on file changes; RepoRegistry only forwards actual repository list changes.
    this.repoSubs.set(
      key,
      repo.state.onDidChange(() => this.changed.fire()),
    );
  }
}
