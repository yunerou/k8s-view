import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { KubeConfigSource, type KubeContextInfo } from "../../app/ports/KubeConfigSource";
import { LOGGER } from "../../di/tokens";
import { KubernetesExtensionGateway } from "../ms-kubernetes/KubernetesExtensionGateway";
import type { KubeConfigAccess } from "./KubeConfigAccess";

/**
 * Read kubeconfig from the MS extension's path (including `vs-kubernetes.kubeconfig`);
 * without a custom setting, use `loadFromDefault()` to merge `KUBECONFIG=a:b` correctly. Watch files for reloads.
 */
@injectable()
export class KubeConfigProvider extends KubeConfigSource implements KubeConfigAccess, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private kc = new KubeConfig();
  private files: string[] = [];
  private error: string | undefined;
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly gateway = inject(KubernetesExtensionGateway),
    private readonly log = inject(LOGGER),
  ) {
    super();
  }

  async initialize(): Promise<void> {
    try {
      const config = await this.gateway.configuration();
      this.disposables.push(config.onDidChangeKubeconfigPath(() => this.scheduleReload()));
    } catch (e) {
      this.log.warn(`Kubernetes extension configuration API unavailable: ${(e as Error).message}`);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vs-kubernetes")) this.scheduleReload();
      }),
    );
    await this.reload();
  }

  /** Original KubeConfig (loaded, absolute paths). Do not mutate this object. */
  kubeConfig(): KubeConfig {
    return this.kc;
  }

  contexts(): readonly KubeContextInfo[] {
    return this.kc
      .getContexts()
      .map((c) => ({ name: c.name, cluster: c.cluster, user: c.user, namespace: c.namespace || undefined }));
  }

  currentContext(): string | undefined {
    return this.kc.getCurrentContext() || undefined;
  }

  kubeconfigEnv(): string {
    return this.files.join(delimiter);
  }

  loadError(): string | undefined {
    return this.error;
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    for (const d of [...this.watchers, ...this.disposables]) d.dispose();
    this.changed.dispose();
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 300);
  }

  private async reload(): Promise<void> {
    const kc = new KubeConfig();
    this.error = undefined;
    const explicitPath = await this.explicitKubeconfigPath();
    try {
      if (explicitPath) {
        kc.loadFromFile(explicitPath);
        this.files = [explicitPath];
      } else {
        kc.loadFromDefault();
        const env = process.env["KUBECONFIG"];
        this.files = env ? env.split(delimiter).filter(Boolean) : [join(homedir(), ".kube", "config")];
      }
    } catch (e) {
      this.error = `Cannot load kubeconfig: ${(e as Error).message}`;
      this.log.error(this.error);
    }
    this.kc = kc;
    this.watchFiles();
    this.changed.fire();
  }

  /** Path configured by the MS extension; `undefined` = default (KUBECONFIG / ~/.kube/config). */
  private async explicitKubeconfigPath(): Promise<string | undefined> {
    const setting = vscode.workspace.getConfiguration("vs-kubernetes").get<string>("vs-kubernetes.kubeconfig");
    if (!setting) return undefined;
    try {
      const path = (await this.gateway.configuration()).getKubeconfigPath();
      if (path.pathType === "wsl") {
        this.error = "WSL kubeconfig paths are not supported yet; using the default kubeconfig.";
        return undefined;
      }
      return path.hostPath;
    } catch {
      return setting.replace(/^~(?=$|[\\/])/, homedir());
    }
  }

  private watchFiles(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = this.files.map((file) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dirname(file)), basename(file)),
      );
      const onChange = () => this.scheduleReload();
      return vscode.Disposable.from(
        watcher,
        watcher.onDidChange(onChange),
        watcher.onDidCreate(onChange),
        watcher.onDidDelete(onChange),
      );
    });
  }
}
