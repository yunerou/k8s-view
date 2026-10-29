import { EventEmitter } from "vscode";
import { ClusterApi, KubeApiError } from "../../../src/app/ports/ClusterApi";
import { KubeConfigSource, type KubeContextInfo } from "../../../src/app/ports/KubeConfigSource";
import { type RefreshMode, type RemoteConfigSetting, Settings } from "../../../src/app/ports/Settings";
import { StateStore } from "../../../src/app/ports/StateStore";
import type { DangerousSetting } from "../../../src/core/command/policy";

export class FakeKubeConfig extends KubeConfigSource {
  readonly changed = new EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  constructor(
    public list: KubeContextInfo[],
    public current: string | undefined,
  ) {
    super();
  }
  contexts() {
    return this.list;
  }
  currentContext() {
    return this.current;
  }
  kubeconfigEnv() {
    return "/home/u/.kube/config";
  }
  loadError() {
    return undefined;
  }
}

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

export class FakeSettings extends Settings {
  readonly changed = new EventEmitter<readonly string[]>();
  readonly onDidChange = this.changed.event;
  values = {
    follow: false,
    protected: [] as string[],
    timeout: 5,
    configFiles: [] as string[],
    remoteConfigs: [] as RemoteConfigSetting[],
    presets: [] as string[],
    autoEnable: true,
    extraPath: [] as string[],
    mode: "watch" as RefreshMode,
    poll: 10,
    debounce: 0,
    maxWatches: 20,
    pauseUnfocused: false,
    dangerous: "restricted" as DangerousSetting,
    tailLines: 200,
    timestamps: false,
    highlight: true,
    hiddenViews: [] as string[],
    favoriteViews: [] as string[],
  };
  set(patch: Partial<FakeSettings["values"]>, keys: string[] = Object.keys(patch)) {
    Object.assign(this.values, patch);
    this.changed.fire(keys);
  }
  followKubernetesExtension() {
    return this.values.follow;
  }
  protectedContexts() {
    return this.values.protected;
  }
  connectTimeoutSeconds() {
    return this.values.timeout;
  }
  configFiles() {
    return this.values.configFiles;
  }
  remoteConfigs() {
    return this.values.remoteConfigs;
  }
  enabledPresets() {
    return this.values.presets;
  }
  autoEnablePresets() {
    return this.values.autoEnable;
  }
  extraPath() {
    return this.values.extraPath;
  }
  refreshMode() {
    return this.values.mode;
  }
  pollIntervalSeconds() {
    return this.values.poll;
  }
  debounceMs() {
    return this.values.debounce;
  }
  maxWatches() {
    return this.values.maxWatches;
  }
  pauseWhenUnfocused() {
    return this.values.pauseUnfocused;
  }
  dangerousCommands() {
    return this.values.dangerous;
  }
  logTailLines() {
    return this.values.tailLines;
  }
  logTimestamps() {
    return this.values.timestamps;
  }
  logHighlight() {
    return this.values.highlight;
  }
  hiddenViews() {
    return this.values.hiddenViews;
  }
  async setHiddenViews(ids: readonly string[]) {
    this.set({ hiddenViews: [...ids] }, ["views.hidden"]);
  }
  favoriteViews() {
    return this.values.favoriteViews;
  }
  async setFavoriteViews(ids: readonly string[]) {
    this.set({ favoriteViews: [...ids] }, ["views.favorites"]);
  }
  async setRefresh(mode: RefreshMode, poll?: number) {
    this.set({ mode, ...(poll !== undefined ? { poll } : {}) }, ["refresh.mode", "refresh.pollIntervalSeconds"]);
  }
}

export class FakeClusterApi extends ClusterApi {
  versions = new Map<string, string | Error>();
  namespaces = new Map<string, string[] | Error>();
  /** Contexts requiring sign-in (exec auth): `login` waits for `finishLogin` or signal cancellation. */
  loginRequired = new Set<string>();
  /** Contexts using exec auth (Reconnect always signs in again). */
  execAuth = new Set<string>();
  logins: string[] = [];
  private pendingLogin: (() => void) | undefined;
  /** `version` hangs until the signal is aborted (unresponsive cluster). */
  hang = false;
  async version(context: string, _timeoutMs?: number, signal?: AbortSignal) {
    if (this.hang) await untilAborted(signal);
    const v = this.versions.get(context) ?? "v1.34.0";
    if (v instanceof Error) throw v;
    return v;
  }
  needsLogin(context: string, reauthenticate = false) {
    return this.loginRequired.has(context) || (reauthenticate && this.execAuth.has(context));
  }
  login(context: string, signal: AbortSignal) {
    this.logins.push(context);
    return new Promise<void>((resolve, reject) => {
      this.pendingLogin = () => {
        this.loginRequired.delete(context);
        resolve();
      };
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  finishLogin() {
    this.pendingLogin?.();
  }
  async listNamespaces(context: string) {
    const v = this.namespaces.get(context) ?? ["default", "kube-system"];
    if (v instanceof Error) throw v;
    return v;
  }
  static forbidden() {
    return new KubeApiError("namespaces is forbidden", 403, "Forbidden");
  }
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
