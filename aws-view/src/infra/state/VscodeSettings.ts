import { homedir } from "node:os";
import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Settings } from "../../app/ports/Settings";
import { isRegionCode } from "../../core/aws/regions";
import type { TagFilter } from "../../core/ec2/filters";
import { Emitter } from "../../core/util/Emitter";
import { expandHome } from "../../core/util/paths";

const SECTION = "awsView";
const KEYS = [
  "regions",
  "defaultTagFilters",
  "idleReminder.enabled",
  "idleReminder.hours",
  "confirmStop",
  "awsCliPath",
  "sshConfigPath",
];

@injectable()
export class VscodeSettings extends Settings implements vscode.Disposable {
  private readonly changed = new Emitter<readonly string[]>();
  readonly onDidChange = this.changed.event;
  private readonly subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    const keys = KEYS.filter((k) => e.affectsConfiguration(`${SECTION}.${k}`));
    if (keys.length > 0) this.changed.fire(keys);
  });

  constructor(private readonly home: string = homedir()) {
    super();
  }

  regions(): readonly string[] {
    const value = this.get<unknown>("regions", []);
    if (!Array.isArray(value)) return [];
    const regions = value.filter((r): r is string => typeof r === "string").map((r) => r.trim());
    return [...new Set(regions.filter(isRegionCode))];
  }

  defaultTagFilters(): readonly TagFilter[] {
    const value = this.get<unknown>("defaultTagFilters", []);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): TagFilter[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const rawKey = record["key"];
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (!key) return [];
      const rawValues = record["values"];
      const values = Array.isArray(rawValues)
        ? rawValues.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
        : [];
      return [{ key, values }];
    });
  }

  idleReminderEnabled(): boolean {
    return this.get<unknown>("idleReminder.enabled", true) !== false;
  }

  idleReminderHours(): number {
    const value = this.get<unknown>("idleReminder.hours", 4);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0.01, value) : 4;
  }

  confirmStop(): boolean {
    return this.get<unknown>("confirmStop", true) !== false;
  }

  awsCliPath(): string {
    return this.userText("awsCliPath") ?? "aws";
  }

  sshConfigPath(): string {
    return expandHome(this.userText("sshConfigPath") ?? "~/.ssh/aws-view.config", this.home);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  private get<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback) as T;
  }

  /** Paths that run or rewrite things on this machine: never taken from a workspace. */
  private userText(key: string): string | undefined {
    const value = vscode.workspace.getConfiguration(SECTION).inspect<unknown>(key)?.globalValue;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}
