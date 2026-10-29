import type * as vscode from "vscode";
import type { DangerousSetting } from "../../core/command/policy";

export type RefreshMode = "watch" | "poll" | "manual";

/** An entry in `k8sView.remoteConfigs`. */
export interface RemoteConfigSetting {
  /** HTTPS URL of a JSON file (raw gist, raw GitHub…). */
  readonly url: string;
  /** Allowed command patterns (see `CommandAllowlist`); empty = block all commands from the file. */
  readonly allowCommands: readonly string[];
  /** Required SHA-256 (hex) of the content; mismatched content is rejected. */
  readonly sha256?: string;
}

/** Port: typed `k8sView.*` settings. */
export abstract class Settings {
  /** Fires when a `k8sView.*` setting changes; the argument lists changed keys (without the prefix). */
  abstract readonly onDidChange: vscode.Event<readonly string[]>;
  abstract followKubernetesExtension(): boolean;
  abstract protectedContexts(): readonly string[];
  abstract connectTimeoutSeconds(): number;
  abstract configFiles(): readonly string[];
  /** User values only (`application` scope): workspaces cannot add sources or broaden the allowlist. */
  abstract remoteConfigs(): readonly RemoteConfigSetting[];
  abstract enabledPresets(): readonly string[];
  abstract autoEnablePresets(): boolean;
  abstract extraPath(): readonly string[];
  abstract refreshMode(): RefreshMode;
  abstract pollIntervalSeconds(): number;
  abstract debounceMs(): number;
  abstract maxWatches(): number;
  abstract pauseWhenUnfocused(): boolean;
  abstract dangerousCommands(): DangerousSetting;
  /** Number of tail lines when opening logs. */
  abstract logTailLines(): number;
  abstract logTimestamps(): boolean;
  /** Color log levels (ERROR, WARN…) in log terminals. */
  abstract logHighlight(): boolean;
  /** View IDs hidden from "Switch view" (and never watched). */
  abstract hiddenViews(): readonly string[];
  /** Favorite view IDs by slot: element `i` corresponds to table hotkey `i + 1`; empty string = empty slot. */
  abstract favoriteViews(): readonly string[];
  /** Refresh mode selected in the Context panel: `watch`, or `poll` with an interval in seconds. */
  abstract setRefresh(mode: RefreshMode, pollIntervalSeconds?: number): Thenable<void>;
  abstract setHiddenViews(ids: readonly string[]): Thenable<void>;
  abstract setFavoriteViews(ids: readonly string[]): Thenable<void>;
}
