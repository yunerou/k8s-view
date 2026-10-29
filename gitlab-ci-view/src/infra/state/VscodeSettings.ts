import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type NotificationMode, Settings } from "../../app/ports/Settings";
import type { RefFilterMode } from "../../core/gitlab/model";
import type { HostSetting } from "../../core/remote/remote";
import { Emitter } from "../../core/util/Emitter";

const SECTION = "gitlabCiView";
const KEYS = [
  "hosts",
  "refresh.activeSeconds",
  "refresh.idleSeconds",
  "notifications",
  "tokenExpiryWarningDays",
  "defaultRefFilter",
];

@injectable()
export class VscodeSettings extends Settings implements vscode.Disposable {
  private readonly changed = new Emitter<readonly string[]>();
  readonly onDidChange = this.changed.event;
  private readonly subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    const keys = KEYS.filter((k) => e.affectsConfiguration(`${SECTION}.${k}`));
    if (keys.length > 0) this.changed.fire(keys);
  });

  hosts(): readonly HostSetting[] {
    // `application` scope: read only User values so workspaces cannot redirect tokens.
    const value = vscode.workspace.getConfiguration(SECTION).inspect<unknown>("hosts")?.globalValue;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): HostSetting[] => {
      if (!item || typeof item !== "object") return [];
      const r = item as Record<string, unknown>;
      const text = (key: string) => {
        const v = r[key];
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      };
      const host = text("host");
      if (!host) return [];
      const apiUrl = text("apiUrl");
      const sshAlias = text("sshAlias");
      const caFile = text("caFile");
      const reject = r["rejectUnauthorized"];
      return [
        {
          host: host.toLowerCase(),
          ...(apiUrl ? { apiUrl } : {}),
          ...(sshAlias ? { sshAlias } : {}),
          ...(caFile ? { caFile } : {}),
          ...(typeof reject === "boolean" ? { rejectUnauthorized: reject } : {}),
        },
      ];
    });
  }

  activeRefreshSeconds(): number {
    return Math.max(3, this.get("refresh.activeSeconds", 10));
  }

  idleRefreshSeconds(): number {
    return Math.max(10, this.get("refresh.idleSeconds", 60));
  }

  notifications(): NotificationMode {
    const v = this.get<string>("notifications", "failed");
    return v === "off" || v === "all" ? v : "failed";
  }

  tokenExpiryWarningDays(): number {
    return Math.max(0, this.get("tokenExpiryWarningDays", 7));
  }

  defaultRefFilter(): RefFilterMode {
    return this.get<string>("defaultRefFilter", "current") === "all" ? "all" : "current";
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  private get<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback) as T;
  }
}
