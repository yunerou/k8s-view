import { homedir } from "node:os";
import { inject, injectable } from "@needle-di/core";
import type { Node } from "jsonc-parser";
import * as vscode from "vscode";
import { type ConfigLocatedIssue, ConfigSource, type LoadedConfigFile } from "../../app/ports/ConfigSource";
import { Settings } from "../../app/ports/Settings";
import { CommandAllowlist } from "../../core/command/allowlist";
import type { ConfigOrigin } from "../../core/config/origin";
import { type ConfigIssue, deepest, locate, parseConfigText } from "../../core/config/parseConfig";
import { EXTENSION_CONTEXT, LOGGER } from "../../di/tokens";
import { splitGlob } from "./glob";
import { RemoteConfigCache, type RemoteRefreshResult } from "./RemoteConfigCache";

interface FileState {
  readonly uri: vscode.Uri;
  readonly text: string;
  readonly tree: Node | undefined;
  readonly parseIssues: readonly ConfigIssue[];
}

const WORKSPACE_DIR = ".vscode/k8s-view";
const DEBOUNCE_MS = 300;

/**
 * Find config files from five sources (built-in, preset, remote, user, workspace), parse JSONC + zod,
 * report errors in Problems at the correct line/column, and watch files for hot reload.
 * Remote configs are fetched on activation, when `k8sView.remoteConfigs` changes, and on "Reload remote configs";
 * use cached copies between fetches.
 */
@injectable()
export class ConfigLoader extends ConfigSource implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("k8s-view");
  private readonly files = new Map<string, FileState>();
  private userWatchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remoteFetched = false;

  constructor(
    private readonly context = inject(EXTENSION_CONTEXT),
    private readonly settings = inject(Settings),
    private readonly log = inject(LOGGER),
    private readonly remote = inject(RemoteConfigCache),
  ) {
    super();
    const workspaceWatcher = vscode.workspace.createFileSystemWatcher(`**/${WORKSPACE_DIR}/*.json`);
    this.disposables.push(
      workspaceWatcher,
      workspaceWatcher.onDidChange(() => this.schedule()),
      workspaceWatcher.onDidCreate(() => this.schedule()),
      workspaceWatcher.onDidDelete(() => this.schedule()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
      settings.onDidChange((keys) => {
        if (keys.includes("configFiles")) {
          this.watchUserDirs();
          this.schedule();
        }
        if (keys.includes("remoteConfigs")) {
          this.schedule();
          void this.refreshRemote();
        }
      }),
    );
    this.watchUserDirs();
  }

  isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  /** Fetch all remote configs again; reload config if content changes. */
  async refreshRemote(): Promise<RemoteRefreshResult[]> {
    this.remoteFetched = true;
    const results = await Promise.all(this.settings.remoteConfigs().map((s) => this.remote.refresh(s)));
    if (results.some((r) => r.changed)) this.schedule();
    return results;
  }

  async load(): Promise<readonly LoadedConfigFile[]> {
    // Use cache on initial load to avoid waiting for the network; new content (if any) triggers a reload.
    if (!this.remoteFetched) void this.refreshRemote();
    const resources = vscode.Uri.joinPath(this.context.extensionUri, "resources");
    const sources: { uri: vscode.Uri; origin: ConfigOrigin; preset?: string }[] = [
      ...(await this.list(vscode.Uri.joinPath(resources, "views"))).map((uri) => ({ uri, origin: "builtin" as const })),
      ...(await this.list(vscode.Uri.joinPath(resources, "commands"))).map((uri) => ({
        uri,
        origin: "builtin" as const,
      })),
      ...(await this.list(vscode.Uri.joinPath(resources, "presets"))).map((uri) => ({
        uri,
        origin: "preset" as const,
        preset: uri.path.slice(uri.path.lastIndexOf("/") + 1).replace(/\.json$/, ""),
      })),
    ];
    const remotes: { uri: vscode.Uri; text: string; allowlist: CommandAllowlist; errors: string[] }[] = [];
    for (const source of this.settings.remoteConfigs()) {
      const text = await this.remote.read(source);
      if (text === undefined) continue;
      const { allowlist, errors } = CommandAllowlist.parse(source.allowCommands);
      for (const e of errors) this.log.warn(`k8sView.remoteConfigs (${source.url}): allowCommands ${e}`);
      remotes.push({ uri: this.remote.uriOf(source.url), text, allowlist, errors });
    }
    for (const pattern of this.settings.configFiles()) {
      const glob = splitGlob(pattern, homedir());
      sources.push(
        ...(await this.list(vscode.Uri.file(glob.dir), glob.matches)).map((uri) => ({ uri, origin: "user" as const })),
      );
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      sources.push(
        ...(await this.list(vscode.Uri.joinPath(folder.uri, WORKSPACE_DIR))).map((uri) => ({
          uri,
          origin: "workspace" as const,
        })),
      );
    }

    this.files.clear();
    const loaded: LoadedConfigFile[] = [];
    const add = (uri: vscode.Uri, origin: ConfigOrigin, text: string, extra: Partial<LoadedConfigFile> = {}) => {
      const parsed = parseConfigText(text);
      const id = uri.toString();
      this.files.set(id, { uri, text, tree: parsed.tree, parseIssues: parsed.issues });
      loaded.push({ id, origin, parsed, ...extra });
      return parsed;
    };
    // Load order: built-in, preset, remote, user, workspace (later sources win).
    const local = async (keep: (s: (typeof sources)[number]) => boolean) => {
      for (const s of sources.filter(keep)) {
        const text = await this.read(s.uri);
        if (text !== undefined) add(s.uri, s.origin, text, s.preset ? { preset: s.preset } : {});
      }
    };
    await local((s) => s.origin === "builtin" || s.origin === "preset");
    for (const r of remotes) {
      const parsed = add(r.uri, "remote", r.text, { allowlist: r.allowlist });
      parsed.issues.push(
        ...r.errors.map((e) => ({
          message: `k8sView.remoteConfigs: allowCommands ${e} (ignored)`,
          offset: 0,
          length: 0,
          path: [],
          severity: "warning" as const,
        })),
      );
    }
    await local((s) => s.origin === "user" || s.origin === "workspace");
    return loaded;
  }

  report(issues: ReadonlyMap<string, readonly ConfigLocatedIssue[]>): void {
    this.diagnostics.clear();
    for (const [id, file] of this.files) {
      const located = (issues.get(id) ?? []).map((i) => {
        const pos = file.tree ? locate(deepest(file.tree, i.path)) : { offset: 0, length: 0 };
        return { ...pos, message: i.message, severity: i.severity };
      });
      const all = [...file.parseIssues, ...located];
      if (all.length === 0) continue;
      const lines = lineStarts(file.text);
      this.diagnostics.set(
        file.uri,
        all.map((i) => {
          const d = new vscode.Diagnostic(
            new vscode.Range(position(lines, i.offset), position(lines, i.offset + Math.max(i.length, 1))),
            i.message,
            i.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
          );
          d.source = "k8s-view";
          return d;
        }),
      );
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of [...this.userWatchers, ...this.disposables]) d.dispose();
    this.diagnostics.dispose();
    this.changed.dispose();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(), DEBOUNCE_MS);
  }

  private watchUserDirs(): void {
    for (const w of this.userWatchers) w.dispose();
    this.userWatchers = this.settings.configFiles().map((pattern) => {
      const glob = splitGlob(pattern, homedir());
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(glob.dir), "*.json"),
      );
      return vscode.Disposable.from(
        watcher,
        watcher.onDidChange(() => this.schedule()),
        watcher.onDidCreate(() => this.schedule()),
        watcher.onDidDelete(() => this.schedule()),
      );
    });
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (e) {
      this.log.warn(`Cannot read ${uri.fsPath}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async list(
    dir: vscode.Uri,
    matches: (name: string) => boolean = (n) => n.endsWith(".json"),
  ): Promise<vscode.Uri[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && matches(name))
        .map(([name]) => name)
        .sort()
        .map((name) => vscode.Uri.joinPath(dir, name));
    } catch {
      return [];
    }
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function position(starts: readonly number[], offset: number): vscode.Position {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return new vscode.Position(lo, offset - starts[lo]!);
}
