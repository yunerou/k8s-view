import type * as vscode from "vscode";
import type { CommandAllowlist } from "../../core/command/allowlist";
import type { ConfigOrigin } from "../../core/config/origin";
import type { JsonPathSegment, ParsedConfig } from "../../core/config/parseConfig";

export interface LoadedConfigFile {
  /** Unique URI string. */
  readonly id: string;
  readonly origin: ConfigOrigin;
  /** Preset name (`fluxcd`, `cert-manager`) for preset sources. */
  readonly preset?: string;
  /** Allowed commands for a `remote` source (absent = block all). */
  readonly allowlist?: CommandAllowlist;
  readonly parsed: ParsedConfig;
}

/** Errors arising after parsing (extends, expression compilation), located by JSON paths in the file. */
export interface ConfigLocatedIssue {
  readonly path: readonly JsonPathSegment[];
  readonly message: string;
  readonly severity: "error" | "warning";
}

/** Port: find, read, and watch config files; infra binds `ConfigLoader` (reports errors in Problems). */
export abstract class ConfigSource {
  abstract readonly onDidChange: vscode.Event<void>;
  /** Files in load order: built-in, preset, remote, user, workspace. */
  abstract load(): Promise<readonly LoadedConfigFile[]>;
  /** Replace all post-processing errors, keyed by `LoadedConfigFile.id`. */
  abstract report(issues: ReadonlyMap<string, readonly ConfigLocatedIssue[]>): void;
  abstract isWorkspaceTrusted(): boolean;
}
