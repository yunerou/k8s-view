import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { BranchStatusService } from "../app/BranchStatusService";
import { type RepoRef, RepoRegistry } from "../app/RepoRegistry";
import { statusIcon, statusLabel } from "../core/gitlab/status";

/** `$(icon) repo: status` for the latest pipeline on the current branch, using the repository containing the active file. */
@injectable()
export class StatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "gitlabCiView.pipeline",
    vscode.StatusBarAlignment.Left,
    40,
  );
  private lastRepoId: string | undefined;
  private readonly subs: { dispose(): unknown }[] = [];

  constructor(
    private readonly branches = inject(BranchStatusService),
    private readonly repos = inject(RepoRegistry),
  ) {}

  start(): void {
    this.item.name = "GitLab CI: Pipeline";
    this.subs.push(
      this.branches.onDidChange(() => this.update()),
      this.repos.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const repo = this.currentRepo();
    const p = repo ? this.branches.latestFor(repo.id) : undefined;
    if (!repo || !p) {
      this.item.hide();
      return;
    }
    this.item.text = `$(${statusIcon(p.status)}) ${repo.name}: ${statusLabel(p.status)}`;
    this.item.tooltip = `GitLab CI: pipeline #${p.id} on ${p.ref} (${statusLabel(p.status)}). Click to open.`;
    this.item.backgroundColor =
      p.status === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.command = {
      command: "gitlabCiView.openFullView",
      title: "Open pipeline",
      arguments: [{ repoId: repo.id, pipelineId: p.id }],
    };
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.item.dispose();
  }

  private currentRepo(): RepoRef | undefined {
    const repos = this.repos.repos();
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    // Nested repositories: choose the repository with the longest path.
    const matched = uri
      ? repos
          .filter((r) => uri === r.id || uri.startsWith(`${r.id.replace(/\/$/, "")}/`))
          .sort((a, b) => b.id.length - a.id.length)[0]
      : undefined;
    if (matched) this.lastRepoId = matched.id;
    return matched ?? (repos.length === 1 ? repos[0] : repos.find((r) => r.id === this.lastRepoId));
  }
}
