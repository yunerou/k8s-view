import { Notifier } from "../../../src/app/ports/Notifier";
import { type InputOptions, type PickItem, Prompter } from "../../../src/app/ports/Prompter";
import { Runner, type RunOptions, type RunResult } from "../../../src/app/ports/Runner";
import { Settings } from "../../../src/app/ports/Settings";
import { StateStore } from "../../../src/app/ports/StateStore";
import type { TagFilter } from "../../../src/core/ec2/filters";
import { Emitter } from "../../../src/core/util/Emitter";

/** Like globalState: values are copied (JSON-like) and `undefined` removes the key. */
export class FakeState extends StateStore {
  global = new Map<string, unknown>();
  getGlobal<T>(key: string) {
    return this.global.get(key) as T | undefined;
  }
  async setGlobal(key: string, value: unknown) {
    if (value === undefined) this.global.delete(key);
    else this.global.set(key, structuredClone(value));
  }
}

export class FakeSettings extends Settings {
  private readonly changed = new Emitter<readonly string[]>();
  readonly onDidChange = this.changed.event;
  values = {
    regions: [] as string[],
    defaultTagFilters: [] as TagFilter[],
    idleReminderEnabled: true,
    idleReminderHours: 4,
    confirmStop: true,
    awsCliPath: "aws",
    sshConfigPath: "/home/me/.ssh/aws-view.config",
  };
  set(patch: Partial<FakeSettings["values"]>, keys: string[] = Object.keys(patch)) {
    Object.assign(this.values, patch);
    this.changed.fire(keys);
  }
  regions() {
    return this.values.regions;
  }
  defaultTagFilters() {
    return this.values.defaultTagFilters;
  }
  idleReminderEnabled() {
    return this.values.idleReminderEnabled;
  }
  idleReminderHours() {
    return this.values.idleReminderHours;
  }
  confirmStop() {
    return this.values.confirmStop;
  }
  awsCliPath() {
    return this.values.awsCliPath;
  }
  sshConfigPath() {
    return this.values.sshConfigPath;
  }
}

export interface Shown {
  readonly kind: "pick" | "input" | "confirm";
  readonly title: string;
  readonly items?: readonly PickItem<unknown>[] | undefined;
  /** Initial value of an input, detail of a confirmation. */
  readonly value?: string | undefined;
}

/** Answers sequentially from `answers`: picks (`value`), inputs (string) and confirmations (boolean). */
export class FakePrompter extends Prompter {
  readonly answers: unknown[] = [];
  readonly shown: Shown[] = [];

  async pick<T>(items: readonly PickItem<T>[], options: { title: string }): Promise<T | undefined> {
    this.shown.push({ kind: "pick", title: options.title, items });
    return this.next() as T | undefined;
  }

  async input(options: InputOptions): Promise<string | undefined> {
    this.shown.push({ kind: "input", title: options.title, value: options.value });
    const v = this.next() as string | undefined;
    const problem = v === undefined ? undefined : options.validate?.(v);
    if (problem) throw new Error(`FakePrompter: "${v}" is invalid: ${problem}`);
    return v;
  }

  async confirm(message: string, detail: string): Promise<boolean> {
    this.shown.push({ kind: "confirm", title: message, value: detail });
    return this.next() === true;
  }

  private next(): unknown {
    if (this.answers.length === 0) throw new Error("FakePrompter: no answer queued");
    return this.answers.shift();
  }
}

export class FakeNotifier extends Notifier {
  readonly messages: { level: "info" | "warn" | "error"; message: string; actions: readonly string[] }[] = [];
  readonly progressTitles: string[] = [];
  reply: string | undefined;
  /** Abort the progress signal right away (simulates the Cancel button). */
  cancelProgress = false;
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
  async progress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.progressTitles.push(title);
    const controller = new AbortController();
    if (this.cancelProgress) controller.abort();
    return task(controller.signal);
  }
}

export class FakeRunner extends Runner {
  readonly calls: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> | undefined }[] =
    [];
  handler: (command: string, args: readonly string[]) => RunResult = () => ({ code: 0, stdout: "", stderr: "" });
  async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ command, args, env: options.env });
    options.signal?.throwIfAborted();
    return this.handler(command, args);
  }
}

import { Workbench } from "../../../src/app/ports/Workbench";

export class FakeWorkbench extends Workbench {
  authority: string | undefined;
  extensions = new Set(["ms-vscode-remote.remote-ssh"]);
  readonly opened: { authority: string; folderPath: string }[] = [];
  readonly terminals: { name: string; shellPath: string; shellArgs: readonly string[] }[] = [];
  readonly installed: string[] = [];
  readonly urls: string[] = [];
  remoteAuthority() {
    return this.authority;
  }
  async openRemoteWindow(authority: string, folderPath: string) {
    this.opened.push({ authority, folderPath });
  }
  openTerminal(name: string, shellPath: string, shellArgs: readonly string[]) {
    this.terminals.push({ name, shellPath, shellArgs });
  }
  hasExtension(id: string) {
    return this.extensions.has(id);
  }
  async installExtension(id: string) {
    this.installed.push(id);
  }
  async openExternal(url: string) {
    this.urls.push(url);
  }
}

import { type KeyPair, SshConfigStore } from "../../../src/app/ports/SshConfigStore";

export class FakeSshConfigStore extends SshConfigStore {
  readonly knownHostsFile = "/storage/known_hosts";
  include = false;
  readonly hosts = new Map<string, string>();
  async hasInclude() {
    return this.include;
  }
  async addInclude() {
    this.include = true;
  }
  async upsertHost(alias: string, block: string) {
    this.hosts.set(alias, block);
  }
  async ensureKeyPair(): Promise<KeyPair> {
    return { privateKey: "/storage/id_ed25519", publicKey: "/storage/id_ed25519.pub" };
  }
}
