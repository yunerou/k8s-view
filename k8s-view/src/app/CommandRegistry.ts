import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { CommandAllowlist } from "../core/command/allowlist";
import { type CommandDefinition, compileCommand } from "../core/command/CommandDefinition";
import type { ConfigOrigin } from "../core/config/origin";
import { type CommandConfig, type CommandPatchConfig, CommandSchema } from "../core/config/schema";
import { ExpressionEngine } from "../core/expression/ExpressionEngine";
import type { KubeResource } from "../core/resource/KubeResource";
import { applyCommandPatch } from "../core/view/merge";
import type { LoadedConfigFile } from "./ports/ConfigSource";
import { type ApplyContext, addIssue, type IssueMap } from "./ViewRegistry";

/** Command declaration location (file + index in `commands`), for snippet "Edit"/"Delete". */
export interface CommandLocation {
  readonly fileId: string;
  readonly index: number;
  readonly origin: ConfigOrigin;
}

interface Pending {
  config: CommandConfig;
  origin: ConfigOrigin;
  fileId: string;
  index: number;
  /** `run` originates from remote config (even if a later file uses `extends` without replacing `run`). */
  allowlist: CommandAllowlist | undefined;
}

/**
 * Commands by `id` from all sources, filtered by resource; workspace commands load only in trusted workspaces;
 * remote config commands load only when `run` matches their source's allowlist.
 */
@injectable()
export class CommandRegistry implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private commands = new Map<string, CommandDefinition>();
  private locations = new Map<string, CommandLocation>();
  private readonly engine = new ExpressionEngine("safe");

  get(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  all(): CommandDefinition[] {
    return sorted([...this.commands.values()].filter((c) => c.config.enabled));
  }

  forResource(resource: KubeResource): CommandDefinition[] {
    return this.all().filter((c) => !c.isBatch && c.matches(resource));
  }

  locationOf(id: string): CommandLocation | undefined {
    return this.locations.get(id);
  }

  snippets(target?: "namespace" | "context"): CommandDefinition[] {
    return this.all().filter((c) => c.isSnippet && (target === undefined || c.target === target));
  }

  apply(files: readonly LoadedConfigFile[], ctx: ApplyContext, issues: IssueMap): void {
    const pending = new Map<string, Pending>();
    for (const file of files) {
      if (file.origin === "preset" && !ctx.isPresetActive(file.preset)) continue;
      if (file.origin === "workspace" && !ctx.trusted) continue;
      const remoteAllowlist = file.origin === "remote" ? (file.allowlist ?? CommandAllowlist.empty) : undefined;
      for (const { index, config } of file.parsed.commands) {
        if (!("extends" in config)) {
          const full = config as CommandConfig;
          if (!admit(full, remoteAllowlist, issues, file.id, index)) continue;
          pending.set(full.id, {
            config: full,
            origin: file.origin,
            fileId: file.id,
            index,
            allowlist: remoteAllowlist,
          });
          continue;
        }
        const patch = config as CommandPatchConfig;
        const base = pending.get(patch.extends);
        if (!base) {
          addIssue(issues, file.id, {
            path: ["commands", index, "extends"],
            message: `Unknown command '${patch.extends}' (extends must point to a command loaded earlier)`,
            severity: "error",
          });
          continue;
        }
        let safePatch: CommandPatchConfig = patch;
        if ((file.origin === "workspace" || file.origin === "remote") && base.origin !== file.origin) {
          // Third-party repositories/gists cannot disable dangerous flags or confirmations on built-in/preset/user commands.
          const weakened =
            (patch.dangerous === false && base.config.dangerous) ||
            (patch.confirm !== undefined && base.config.confirm !== undefined);
          if (weakened) {
            addIssue(issues, file.id, {
              path: ["commands", index],
              message: `${file.origin === "remote" ? "Remote" : "Workspace"} config cannot lower 'dangerous' or replace 'confirm' of '${patch.extends}'; those fields are ignored`,
              severity: "warning",
            });
            const { dangerous: _d, confirm: _c, ...rest } = patch;
            safePatch = rest;
          }
        }
        const merged = CommandSchema.safeParse(applyCommandPatch(base.config, safePatch));
        if (!merged.success) {
          addIssue(issues, file.id, {
            path: ["commands", index],
            message: merged.error.issues[0]?.message ?? "Invalid command",
            severity: "error",
          });
          continue;
        }
        // A later file retaining a remote command's `run` remains subject to its allowlist.
        const allowlist = remoteAllowlist ?? (patch.run === undefined ? base.allowlist : undefined);
        if (!admit(merged.data, allowlist, issues, file.id, index)) continue;
        pending.set(patch.id ?? patch.extends, {
          config: { ...merged.data, id: patch.id ?? patch.extends },
          origin: file.origin,
          fileId: file.id,
          index,
          allowlist,
        });
      }
    }
    const next = new Map<string, CommandDefinition>();
    const locations = new Map<string, CommandLocation>();
    for (const [id, p] of pending) {
      locations.set(id, { fileId: p.fileId, index: p.index, origin: p.origin });
      const { command, issues: compileIssues } = compileCommand(p.config, p.origin, this.engine, p.allowlist);
      for (const issue of compileIssues) {
        addIssue(issues, p.fileId, {
          path: ["commands", p.index, ...issue.path],
          message: issue.message,
          severity: "error",
        });
      }
      if (command) next.set(id, command);
    }
    this.commands = next;
    this.locations = locations;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** A command rejected by the allowlist does not replace a previously loaded command with the same ID. */
function admit(
  config: CommandConfig,
  allowlist: CommandAllowlist | undefined,
  issues: IssueMap,
  fileId: string,
  index: number,
): boolean {
  const reason = allowlist?.admit(config.run);
  if (reason === undefined) return true;
  addIssue(issues, fileId, {
    path: ["commands", index, "run"],
    message: `Command '${config.id}' is blocked: ${reason}. Allow it in 'k8sView.remoteConfigs' → allowCommands`,
    severity: "warning",
  });
  return false;
}

function sorted(list: CommandDefinition[]): CommandDefinition[] {
  return list.sort(
    (a, b) =>
      (a.group ?? "￿").localeCompare(b.group ?? "￿") ||
      (a.config.order ?? 1000) - (b.config.order ?? 1000) ||
      a.title.localeCompare(b.title),
  );
}
