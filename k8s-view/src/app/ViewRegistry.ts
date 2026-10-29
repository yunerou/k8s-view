import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import type { ConfigOrigin } from "../core/config/origin";
import { type ViewConfig, type ViewPatchConfig, ViewSchema } from "../core/config/schema";
import { ExpressionEngine } from "../core/expression/ExpressionEngine";
import { applyViewPatch } from "../core/view/merge";
import { compileView, type ViewDefinition } from "../core/view/ViewDefinition";
import type { ConfigLocatedIssue, LoadedConfigFile } from "./ports/ConfigSource";

export interface RegisteredView {
  readonly id: string;
  readonly title: string;
  readonly definition: ViewDefinition;
  /** Final definition origin (the winning file). */
  readonly origin: ConfigOrigin;
  readonly fileId: string;
  readonly index: number;
  /** Includes parts from an untrusted workspace: expressions run with `eval: false`. */
  readonly untrusted: boolean;
  /** View generated in code ("Single resource kind" view), with no file to edit. */
  readonly dynamic?: boolean;
}

export interface ApplyContext {
  readonly trusted: boolean;
  isPresetActive(name: string | undefined): boolean;
}

interface Pending {
  config: ViewConfig;
  origin: ConfigOrigin;
  fileId: string;
  index: number;
  untrusted: boolean;
}

export type IssueMap = Map<string, ConfigLocatedIssue[]>;

export function addIssue(map: IssueMap, fileId: string, issue: ConfigLocatedIssue): void {
  const list = map.get(fileId) ?? [];
  list.push(issue);
  map.set(fileId, list);
}

/** Merge built-in, preset, user, and workspace views by `id` (later sources win), resolve `extends`, and compile. */
@injectable()
export class ViewRegistry implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private entries = new Map<string, RegisteredView>();
  private fromFiles = new Map<string, RegisteredView>();
  private readonly dynamic = new Map<string, RegisteredView>();
  private hidden = new Set<string>();
  private readonly safeEngine = new ExpressionEngine("safe");
  private readonly strictEngine = new ExpressionEngine(false);

  /** Enabled views not hidden by `k8sView.views.hidden`, sorted by `order`, then `title`. */
  views(): RegisteredView[] {
    return this.allViews().filter((v) => !this.hidden.has(v.id));
  }

  /** All enabled views, including hidden ones (for "Show/hide views…"). */
  allViews(): RegisteredView[] {
    return [...this.entries.values()]
      .filter((v) => v.definition.enabled)
      .sort((a, b) => (a.definition.order ?? 1000) - (b.definition.order ?? 1000) || a.title.localeCompare(b.title));
  }

  get(id: string): RegisteredView | undefined {
    return this.entries.get(id);
  }

  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }

  /** Hidden view IDs from `k8sView.views.hidden`; does not reload files. */
  setHidden(ids: readonly string[]): void {
    const next = new Set(ids);
    if (next.size === this.hidden.size && [...next].every((id) => this.hidden.has(id))) return;
    this.hidden = next;
    this.changed.fire();
  }

  /** Add/replace a generated view; a config-file view with the same ID still takes precedence. */
  setDynamic(config: ViewConfig): void {
    const { view } = compileView(config, this.safeEngine);
    this.dynamic.set(config.id, {
      id: config.id,
      title: view.title,
      definition: view,
      origin: "builtin",
      fileId: "",
      index: -1,
      untrusted: false,
      dynamic: true,
    });
    this.rebuild();
  }

  apply(files: readonly LoadedConfigFile[], ctx: ApplyContext, issues: IssueMap): void {
    const pending = new Map<string, Pending>();
    for (const file of files) {
      if (file.origin === "preset" && !ctx.isPresetActive(file.preset)) continue;
      const untrusted = file.origin === "workspace" && !ctx.trusted;
      for (const { index, config } of file.parsed.views) {
        if (!("extends" in config)) {
          const full = config as ViewConfig;
          pending.set(full.id, { config: full, origin: file.origin, fileId: file.id, index, untrusted });
          continue;
        }
        const patch = config as ViewPatchConfig;
        const base = pending.get(patch.extends);
        if (!base) {
          addIssue(issues, file.id, {
            path: ["views", index, "extends"],
            message: `Unknown view '${patch.extends}' (extends must point to a view loaded earlier)`,
            severity: "error",
          });
          continue;
        }
        const merged = ViewSchema.safeParse(applyViewPatch(base.config, patch));
        if (!merged.success) {
          const first = merged.error.issues[0];
          addIssue(issues, file.id, {
            path: ["views", index],
            message:
              `Result of extends '${patch.extends}' is invalid: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim(),
            severity: "error",
          });
          continue;
        }
        const id = patch.id ?? patch.extends;
        pending.set(id, {
          config: merged.data,
          origin: file.origin,
          fileId: file.id,
          index,
          untrusted: untrusted || base.untrusted,
        });
      }
    }

    const next = new Map<string, RegisteredView>();
    for (const [id, p] of pending) {
      const { view, issues: compileIssues } = compileView(p.config, p.untrusted ? this.strictEngine : this.safeEngine);
      for (const issue of compileIssues) {
        addIssue(issues, p.fileId, {
          path: ["views", p.index, ...issue.path],
          message: issue.message,
          severity: "error",
        });
      }
      next.set(id, {
        id,
        title: view.title,
        definition: view,
        origin: p.origin,
        fileId: p.fileId,
        index: p.index,
        untrusted: p.untrusted,
      });
    }
    this.fromFiles = next;
    this.rebuild();
  }

  private rebuild(): void {
    const next = new Map(this.fromFiles);
    for (const [id, view] of this.dynamic) if (!next.has(id)) next.set(id, view);
    this.entries = next;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
