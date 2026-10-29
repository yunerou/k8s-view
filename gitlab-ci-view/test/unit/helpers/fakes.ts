import { Notifier } from "../../../src/app/ports/Notifier";
import { type InputOptions, type PickItem, Prompter } from "../../../src/app/ports/Prompter";
import { type GitRepoInfo, RepoSource } from "../../../src/app/ports/RepoSource";
import { SecretStore } from "../../../src/app/ports/SecretStore";
import type { NotificationMode } from "../../../src/app/ports/Settings";
import { Settings } from "../../../src/app/ports/Settings";
import { StateStore } from "../../../src/app/ports/StateStore";
import type { RefFilterMode } from "../../../src/core/gitlab/model";
import type { HostSetting } from "../../../src/core/remote/remote";
import { Emitter } from "../../../src/core/util/Emitter";

export class FakeState extends StateStore {
  workspace = new Map<string, unknown>();
  global = new Map<string, unknown>();
  getWorkspace<T>(key: string) {
    return this.workspace.get(key) as T | undefined;
  }
  async setWorkspace(key: string, value: unknown) {
    this.workspace.set(key, value);
  }
  getGlobal<T>(key: string) {
    return this.global.get(key) as T | undefined;
  }
  async setGlobal(key: string, value: unknown) {
    this.global.set(key, value);
  }
}

export class FakeSecrets extends SecretStore {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key);
  }
  async store(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

export class FakeSettings extends Settings {
  private readonly changed = new Emitter<readonly string[]>();
  readonly onDidChange = this.changed.event;
  values = {
    hosts: [] as HostSetting[],
    active: 10,
    idle: 60,
    notifications: "failed" as NotificationMode,
    warnDays: 7,
    refFilter: "current" as RefFilterMode,
  };
  set(patch: Partial<FakeSettings["values"]>, keys: string[] = Object.keys(patch)) {
    Object.assign(this.values, patch);
    this.changed.fire(keys);
  }
  hosts() {
    return this.values.hosts;
  }
  activeRefreshSeconds() {
    return this.values.active;
  }
  idleRefreshSeconds() {
    return this.values.idle;
  }
  notifications() {
    return this.values.notifications;
  }
  tokenExpiryWarningDays() {
    return this.values.warnDays;
  }
  defaultRefFilter() {
    return this.values.refFilter;
  }
}

/** Answer sequentially from `answers` for both picks (`value`) and inputs (strings). */
export class FakePrompter extends Prompter {
  readonly answers: unknown[] = [];
  readonly shown: { kind: "pick" | "input"; title: string; items?: readonly PickItem<unknown>[] }[] = [];

  async pick<T>(items: readonly PickItem<T>[], options: { title: string }): Promise<T | undefined> {
    this.shown.push({ kind: "pick", title: options.title, items });
    return this.next() as T | undefined;
  }

  async input(options: InputOptions): Promise<string | undefined> {
    this.shown.push({ kind: "input", title: options.title });
    const v = this.next() as string | undefined;
    const problem = v === undefined ? undefined : options.validate?.(v);
    if (problem) throw new Error(`FakePrompter: "${v}" is invalid: ${problem}`);
    return v;
  }

  private next(): unknown {
    if (this.answers.length === 0) throw new Error("FakePrompter: no answer queued");
    return this.answers.shift();
  }
}

export class FakeNotifier extends Notifier {
  readonly messages: { level: "info" | "warn" | "error"; message: string; actions: readonly string[] }[] = [];
  reply: string | undefined;
  async info(message: string, ...actions: string[]) {
    this.messages.push({ level: "info", message, actions });
    return this.reply;
  }
  async warn(message: string, ...actions: string[]) {
    this.messages.push({ level: "warn", message, actions });
    return this.reply;
  }
  async error(message: string, ...actions: string[]) {
    this.messages.push({ level: "error", message, actions });
    return this.reply;
  }
}

export class FakeRepoSource extends RepoSource {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  list: GitRepoInfo[] = [];
  set(list: GitRepoInfo[]) {
    this.list = list;
    this.changed.fire();
  }
  repositories() {
    return this.list;
  }
}

export function gitRepo(name: string, url: string, branch: string | undefined = "main"): GitRepoInfo {
  return { rootUri: `file:///ws/${name}`, name, remotes: [{ name: "origin", fetchUrl: url }], branch };
}
