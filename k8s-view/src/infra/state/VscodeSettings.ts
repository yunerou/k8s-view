import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type RefreshMode, type RemoteConfigSetting, Settings } from "../../app/ports/Settings";
import type { DangerousSetting } from "../../core/command/policy";

const SECTION = "k8sView";
const KEYS = [
  "context.followKubernetesExtension",
  "context.protected",
  "context.connectTimeoutSeconds",
  "configFiles",
  "remoteConfigs",
  "presets.enabled",
  "presets.autoEnable",
  "extraPath",
  "refresh.mode",
  "refresh.pollIntervalSeconds",
  "refresh.debounceMs",
  "refresh.maxWatches",
  "refresh.pauseWhenUnfocused",
  "commands.dangerous",
  "logs.tailLines",
  "logs.timestamps",
  "logs.highlight",
  "views.hidden",
  "views.favorites",
];

/** Minimum poll interval: below 3 s adds API server load without visible benefit. */
export const MIN_POLL_SECONDS = 3;
/** Table hotkeys `1`–`9`. */
const MAX_FAVORITES = 9;

@injectable()
export class VscodeSettings extends Settings implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<readonly string[]>();
  readonly onDidChange = this.changed.event;
  private readonly subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    const keys = KEYS.filter((k) => e.affectsConfiguration(`${SECTION}.${k}`));
    if (keys.length > 0) this.changed.fire(keys);
  });

  followKubernetesExtension(): boolean {
    return this.get("context.followKubernetesExtension", false);
  }
  protectedContexts(): readonly string[] {
    return this.get<string[]>("context.protected", []);
  }
  connectTimeoutSeconds(): number {
    return this.get("context.connectTimeoutSeconds", 5);
  }
  configFiles(): readonly string[] {
    return this.get<string[]>("configFiles", ["~/.config/k8s-view/*.json"]);
  }
  remoteConfigs(): readonly RemoteConfigSetting[] {
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>("remoteConfigs");
    const value = inspected?.globalValue;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): RemoteConfigSetting[] => {
      if (!item || typeof item !== "object" || typeof item.url !== "string") return [];
      const allow = Array.isArray(item.allowCommands) ? item.allowCommands : [];
      return [
        {
          url: item.url,
          allowCommands: allow.filter((p: unknown): p is string => typeof p === "string"),
          ...(typeof item.sha256 === "string" && item.sha256 ? { sha256: item.sha256.toLowerCase() } : {}),
        },
      ];
    });
  }
  enabledPresets(): readonly string[] {
    return this.get<string[]>("presets.enabled", []);
  }
  autoEnablePresets(): boolean {
    return this.get("presets.autoEnable", true);
  }
  extraPath(): readonly string[] {
    return this.get<string[]>("extraPath", []);
  }
  refreshMode(): RefreshMode {
    return this.get<RefreshMode>("refresh.mode", "watch");
  }
  pollIntervalSeconds(): number {
    return Math.max(MIN_POLL_SECONDS, this.get("refresh.pollIntervalSeconds", 10));
  }
  debounceMs(): number {
    return Math.max(0, this.get("refresh.debounceMs", 250));
  }
  maxWatches(): number {
    return Math.max(1, this.get("refresh.maxWatches", 20));
  }
  pauseWhenUnfocused(): boolean {
    return this.get("refresh.pauseWhenUnfocused", false);
  }
  dangerousCommands(): DangerousSetting {
    // `application` scope: read only user values; workspaces cannot override them.
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect<DangerousSetting>("commands.dangerous");
    return inspected?.globalValue ?? inspected?.defaultValue ?? "restricted";
  }

  logTailLines(): number {
    return Math.max(0, Math.floor(this.get("logs.tailLines", 200)));
  }
  logTimestamps(): boolean {
    return this.get("logs.timestamps", false);
  }
  logHighlight(): boolean {
    return this.get("logs.highlight", true);
  }
  hiddenViews(): readonly string[] {
    return this.get<string[]>("views.hidden", []);
  }

  favoriteViews(): readonly string[] {
    return this.get<unknown[]>("views.favorites", [])
      .slice(0, MAX_FAVORITES)
      .map((v) => (typeof v === "string" ? v : ""));
  }

  async setRefresh(mode: RefreshMode, pollIntervalSeconds?: number): Promise<void> {
    await this.update("refresh.mode", mode);
    if (pollIntervalSeconds !== undefined) await this.update("refresh.pollIntervalSeconds", pollIntervalSeconds);
  }

  async setHiddenViews(ids: readonly string[]): Promise<void> {
    await this.update("views.hidden", [...new Set(ids)].sort());
  }

  async setFavoriteViews(ids: readonly string[]): Promise<void> {
    const slots = ids.slice(0, MAX_FAVORITES);
    // Trim trailing empty slots to keep settings concise.
    while (slots.length > 0 && !slots.at(-1)) slots.pop();
    await this.update("views.favorites", slots);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  private get<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
  }

  /** Write to workspace settings if already set there (so the change takes effect); otherwise write to user settings. */
  private async update(key: string, value: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const target =
      config.inspect(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update(key, value, target);
  }
}
