import { inject, injectable } from "@needle-di/core";
import type * as vscode from "vscode";
import { CommandRegistry } from "./CommandRegistry";
import { HotkeyService } from "./HotkeyService";
import { ConfigSource } from "./ports/ConfigSource";
import { Settings } from "./ports/Settings";
import { type IssueMap, ViewRegistry } from "./ViewRegistry";

/** Load config files (when files or preset settings change), then update ViewRegistry, CommandRegistry, and HotkeyService. */
@injectable()
export class ConfigService implements vscode.Disposable {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly source = inject(ConfigSource),
    private readonly settings = inject(Settings),
    private readonly views = inject(ViewRegistry),
    private readonly commands = inject(CommandRegistry),
    private readonly hotkeys = inject(HotkeyService),
  ) {
    this.disposables.push(
      this.source.onDidChange(() => void this.reload()),
      this.settings.onDidChange((keys) => {
        if (keys.some((k) => k.startsWith("presets"))) void this.reload();
        if (keys.includes("views.hidden")) this.views.setHidden(this.settings.hiddenViews());
      }),
    );
  }

  reload(): Promise<void> {
    const run = async () => {
      const files = await this.source.load();
      const issues: IssueMap = new Map(files.map((f) => [f.id, []]));
      const enabled = new Set(this.settings.enabledPresets());
      const ctx = {
        trusted: this.source.isWorkspaceTrusted(),
        isPresetActive: (name: string | undefined) =>
          this.settings.autoEnablePresets() || (name !== undefined && enabled.has(name)),
      };
      this.views.setHidden(this.settings.hiddenViews());
      this.views.apply(files, ctx, issues);
      this.commands.apply(files, ctx, issues);
      this.hotkeys.apply(files, ctx);
      this.source.report(issues);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  whenIdle(): Promise<unknown> {
    return this.queue;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
