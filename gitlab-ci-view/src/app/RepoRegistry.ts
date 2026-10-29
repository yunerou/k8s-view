import { inject, injectable } from "@needle-di/core";
import {
  type GitLabTarget,
  type HostTarget,
  hostTarget,
  parseRemoteUrl,
  resolveRepoTarget,
} from "../core/remote/remote";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { RepoSource } from "./ports/RepoSource";
import { Settings } from "./ports/Settings";
import { TokenStore } from "./TokenStore";

export interface RepoRef extends GitLabTarget {
  /** Repository `rootUri`. */
  readonly id: string;
  readonly name: string;
  readonly branch: string | undefined;
}

/** Hosts known not to be GitLab: exclude from token setup suggestions. */
const NOT_GITLAB = new Set(["github.com", "bitbucket.org", "dev.azure.com", "ssh.dev.azure.com"]);

/** Workspace GitLab repositories; recomputed when Git, the `hosts` setting, or the token list changes. */
@injectable()
export class RepoRegistry implements Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private list: RepoRef[] = [];
  private signature = "[]";
  private readonly subs: Disposable[];

  constructor(
    private readonly source = inject(RepoSource),
    private readonly settings = inject(Settings),
    private readonly tokens = inject(TokenStore),
  ) {
    this.subs = [
      source.onDidChange(() => this.recompute()),
      settings.onDidChange((keys) => {
        if (keys.includes("hosts")) this.recompute();
      }),
      tokens.onDidChange(() => this.recompute()),
    ];
    this.recompute();
  }

  repos(): readonly RepoRef[] {
    return this.list;
  }

  get(id: string): RepoRef | undefined {
    return this.list.find((r) => r.id === id);
  }

  /** Hosts from all remotes (including those not yet recognized as GitLab), for token setup suggestions. */
  hostTargets(): HostTarget[] {
    const hosts = this.settings.hosts();
    const out = new Map<string, HostTarget>();
    for (const r of this.list) out.set(r.host, { host: r.host, apiUrl: r.apiUrl });
    for (const info of this.source.repositories()) {
      for (const remote of info.remotes) {
        const loc = parseRemoteUrl(remote.fetchUrl ?? remote.pushUrl ?? "");
        if (!loc || NOT_GITLAB.has(loc.host)) continue;
        const target = hostTarget(loc.host, hosts);
        if (!out.has(target.host)) out.set(target.host, target);
      }
    }
    return [...out.values()];
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }

  private recompute(): void {
    const hosts = this.settings.hosts();
    const tokenHosts = this.tokens.hosts();
    const next = this.source
      .repositories()
      .flatMap((info): RepoRef[] => {
        const target = resolveRepoTarget(info.remotes, hosts, tokenHosts);
        return target ? [{ id: info.rootUri, name: info.name, branch: info.branch, ...target }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const signature = JSON.stringify(next);
    if (signature === this.signature) return;
    this.list = next;
    this.signature = signature;
    this.changed.fire();
  }
}
