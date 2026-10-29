import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type HotkeySpec, type HotkeyState, resolveHotkeys } from "../shared/hotkeys";
import type { LoadedConfigFile } from "./ports/ConfigSource";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";
import { type ApplyContext, ViewRegistry } from "./ViewRegistry";

const ENABLED_KEY = "k8sView.hotkeys.enabled";

/**
 * Table hotkeys: defaults + `hotkeys` from config files (later files win for the same key),
 * with globally persisted ON/OFF mode. Only intercept keys (and block forwarding to VS Code) when ON.
 * Keys `1`–`9` reference favorite views in the `k8sView.views.favorites` setting.
 */
@injectable()
export class HotkeyService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private bindings = resolveHotkeys([]);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store = inject(StateStore),
    private readonly settings = inject(Settings),
    private readonly views = inject(ViewRegistry),
  ) {
    this.disposables.push(
      this.settings.onDidChange((keys) => {
        if (keys.includes("views.favorites")) this.changed.fire();
      }),
      this.views.onDidChange(() => this.changed.fire()),
    );
  }

  get enabled(): boolean {
    return this.store.getGlobal<boolean>(ENABLED_KEY) === true;
  }

  state(): HotkeyState {
    const favorites = this.settings.favoriteViews().map((id) => (id ? (this.views.get(id)?.title ?? id) : ""));
    return { enabled: this.enabled, bindings: this.bindings, favorites };
  }

  async toggle(): Promise<void> {
    await this.store.setGlobal(ENABLED_KEY, !this.enabled);
    this.changed.fire();
  }

  apply(files: readonly LoadedConfigFile[], ctx: ApplyContext): void {
    const specs: HotkeySpec[] = [];
    for (const file of files) {
      if (file.origin === "preset" && !ctx.isPresetActive(file.preset)) continue;
      if (file.origin === "workspace" && !ctx.trusted) continue;
      if (file.parsed.hotkeys) specs.push(...file.parsed.hotkeys.bindings);
    }
    this.bindings = resolveHotkeys(specs);
    this.changed.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}
