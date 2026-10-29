import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { ClusterContext, isProtectedContext, type NamespaceScope } from "../core/context/ClusterContext";
import { ClusterApi, KubeApiError } from "./ports/ClusterApi";
import { KubeConfigSource, type KubeContextInfo } from "./ports/KubeConfigSource";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";

export type ConnectionState =
  | { readonly state: "unknown" }
  /** `login`: waiting for the exec auth plugin to run in an interactive terminal. */
  | { readonly state: "connecting"; readonly login?: boolean }
  | { readonly state: "connected"; readonly serverVersion: string }
  | { readonly state: "error"; readonly message: string };

export interface NamespaceList {
  readonly items: readonly string[];
  /** No namespace list permission: suggest recent/default namespaces and allow manual entry. */
  readonly forbidden: boolean;
}

const CONTEXT_KEY = "k8sView.context";
const namespaceKey = (ctx: string) => `k8sView.namespace/${ctx}`;
const recentKey = (ctx: string) => `k8sView.recentNamespaces/${ctx}`;
const MAX_RECENT = 10;

/** Single source of truth for the (context, namespace) pair shared by all views and commands. */
@injectable()
export class ContextService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ClusterContext | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly statusChanged = new vscode.EventEmitter<void>();
  /** Connection state or namespace list changed. */
  readonly onDidChangeStatus = this.statusChanged.event;

  private context: ClusterContext | undefined;
  private connectionState: ConnectionState = { state: "unknown" };
  private namespaceList: NamespaceList = { items: [], forbidden: false };
  /** Active connection check (cancelable with the Cancel button or by switching context). */
  private connecting: AbortController | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly kubeconfig = inject(KubeConfigSource),
    private readonly state = inject(StateStore),
    private readonly settings = inject(Settings),
    private readonly api = inject(ClusterApi),
  ) {
    this.disposables.push(
      this.kubeconfig.onDidChange(() => this.enqueue(() => this.reload())),
      this.settings.onDidChange((keys) => {
        if (keys.some((k) => k.startsWith("context.protected")) && this.context) {
          this.set(this.build(this.context.name, this.context.scope));
        }
      }),
    );
  }

  get current(): ClusterContext | undefined {
    return this.context;
  }

  get connection(): ConnectionState {
    return this.connectionState;
  }

  get namespaces(): NamespaceList {
    return this.namespaceList;
  }

  contexts(): readonly KubeContextInfo[] {
    return this.kubeconfig.contexts();
  }

  /** `current-context` in kubeconfig (may differ from the selected context). */
  kubeconfigCurrentContext(): string | undefined {
    return this.kubeconfig.currentContext();
  }

  kubeconfigEnv(): string {
    return this.kubeconfig.kubeconfigEnv();
  }

  loadError(): string | undefined {
    return this.kubeconfig.loadError();
  }

  async initialize(): Promise<void> {
    await this.enqueue(() => this.reload());
  }

  /** Wait for queued kubeconfig reloads (used in tests). */
  whenIdle(): Promise<unknown> {
    return this.queue;
  }

  async selectContext(name: string): Promise<void> {
    if (!this.info(name)) throw new Error(`Unknown context '${name}'`);
    this.connecting?.abort();
    await this.state.setWorkspace(CONTEXT_KEY, name);
    this.namespaceList = { items: [], forbidden: false };
    this.connectionState = { state: "unknown" };
    this.set(this.build(name, this.rememberedScope(name)));
    this.statusChanged.fire();
  }

  async selectNamespace(scope: NamespaceScope): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    await this.state.setGlobal(namespaceKey(ctx.name), scope);
    if (scope.type === "single") {
      const recent = (this.state.getGlobal<string[]>(recentKey(ctx.name)) ?? []).filter((n) => n !== scope.name);
      await this.state.setGlobal(recentKey(ctx.name), [scope.name, ...recent].slice(0, MAX_RECENT));
    }
    this.set(ctx.withScope(scope));
  }

  /**
   * Call `/version`; contexts using exec auth without credentials sign in through the terminal first.
   * `reauthenticate` (Reconnect/Retry): always rerun the exec plugin in a terminal for passkey/password entry.
   */
  async checkConnection(options: { readonly reauthenticate?: boolean } = {}): Promise<ConnectionState> {
    const ctx = this.context;
    if (!ctx) return this.connectionState;
    this.connecting?.abort();
    const controller = new AbortController();
    this.connecting = controller;
    const update = (state: ConnectionState) => {
      if (this.connecting !== controller || this.context?.name !== ctx.name) return;
      this.connectionState = state;
      this.statusChanged.fire();
    };
    try {
      const reauthenticate = options.reauthenticate === true;
      if (this.api.needsLogin(ctx.name, reauthenticate)) {
        update({ state: "connecting", login: true });
        await this.api.login(ctx.name, controller.signal, reauthenticate);
      }
      update({ state: "connecting" });
      const version = await this.api.version(ctx.name, this.settings.connectTimeoutSeconds() * 1000, controller.signal);
      update({ state: "connected", serverVersion: version });
    } catch (e) {
      update({ state: "error", message: controller.signal.aborted ? "Connection cancelled." : errorMessage(e) });
    } finally {
      if (this.connecting === controller) this.connecting = undefined;
    }
    return this.connectionState;
  }

  /** Cancel button while connecting (unresponsive cluster, cancel sign-in). */
  cancelConnection(): void {
    this.connecting?.abort();
  }

  async loadNamespaces(): Promise<NamespaceList> {
    const ctx = this.context;
    if (!ctx) return this.namespaceList;
    try {
      const items = await this.api.listNamespaces(ctx.name);
      this.namespaceList = { items: [...items].sort(), forbidden: false };
    } catch (e) {
      if (!KubeApiError.isForbidden(e)) throw e;
      const suggestions = [
        ...(this.state.getGlobal<string[]>(recentKey(ctx.name)) ?? []),
        this.info(ctx.name)?.namespace,
        ctx.namespace,
      ].filter((n): n is string => !!n);
      this.namespaceList = { items: [...new Set(suggestions)], forbidden: true };
    }
    this.statusChanged.fire();
    return this.namespaceList;
  }

  /** "Follow" mode: the MS extension changed context. */
  async applyExternalContext(name: string | null): Promise<void> {
    if (!this.settings.followKubernetesExtension() || !name || name === this.context?.name || !this.info(name)) return;
    await this.selectContext(name);
  }

  async applyExternalNamespace(namespace: string): Promise<void> {
    if (!this.settings.followKubernetesExtension() || !namespace || namespace === this.context?.namespace) return;
    await this.selectNamespace({ type: "single", name: namespace });
  }

  dispose(): void {
    this.connecting?.abort();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
    this.statusChanged.dispose();
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private reload(): void {
    const contexts = this.kubeconfig.contexts();
    const keep = this.context && contexts.some((c) => c.name === this.context!.name) ? this.context.name : undefined;
    const remembered = this.state.getWorkspace<string>(CONTEXT_KEY);
    const name =
      keep ??
      [remembered, this.kubeconfig.currentContext(), contexts[0]?.name].find(
        (n): n is string => !!n && contexts.some((c) => c.name === n),
      );
    if (!name) {
      this.set(undefined);
      return;
    }
    if (keep) {
      // The context's cluster/user may have changed in the file.
      const next = this.build(name, this.context!.scope);
      if (next.cluster !== this.context!.cluster || next.user !== this.context!.user) this.set(next);
      return;
    }
    this.set(this.build(name, this.rememberedScope(name)));
  }

  private rememberedScope(name: string): NamespaceScope {
    const remembered = this.state.getGlobal<NamespaceScope>(namespaceKey(name));
    if (remembered) return remembered;
    const ns = this.info(name)?.namespace;
    return ns ? { type: "single", name: ns } : { type: "all" };
  }

  private build(name: string, scope: NamespaceScope): ClusterContext {
    const info = this.info(name);
    return new ClusterContext(
      name,
      info?.cluster ?? "",
      info?.user ?? "",
      scope,
      isProtectedContext(name, this.settings.protectedContexts()),
    );
  }

  private info(name: string): KubeContextInfo | undefined {
    return this.kubeconfig.contexts().find((c) => c.name === name);
  }

  private set(ctx: ClusterContext | undefined): void {
    this.context = ctx;
    this.changed.fire(ctx);
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
