import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { User } from "@kubernetes/client-node";
import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { KubeApiError } from "../../app/ports/ClusterApi";
import { Settings } from "../../app/ports/Settings";
import { signInShell } from "../exec/terminalShell";
import { KubeConfigAccess } from "./KubeConfigAccess";

export interface ExecConfig {
  readonly command: string;
  readonly args?: readonly string[] | null;
  readonly env?: readonly { readonly name: string; readonly value: string }[] | null;
  readonly apiVersion?: string;
  readonly interactiveMode?: "Never" | "IfAvailable" | "Always";
}

export interface ExecCredential {
  readonly status: {
    readonly token?: string;
    readonly clientCertificateData?: string;
    readonly clientKeyData?: string;
    readonly expirationTimestamp?: string;
  };
}

/** Kill background execution after this timeout (plugins awaiting sign-in never finish without a terminal). */
const BACKGROUND_TIMEOUT_MS = 60_000;

/**
 * Run exec auth plugins (`aws`, `kubelogin`, `gke-gcloud-auth-plugin`…) instead of client-node's `ExecAuth`:
 * in the background (closed stdin, timeout, cancelable) for ordinary requests, or in an interactive terminal when the user
 * connects without credentials, letting the plugin prompt for passwords / display device codes. Cache credentials per user until expiration.
 */
@injectable()
export class ExecCredentialProvider implements vscode.Disposable {
  private readonly cache = new Map<string, ExecCredential>();
  private readonly inflight = new Map<string, Promise<ExecCredential>>();
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly provider = inject(KubeConfigAccess),
    private readonly settings = inject(Settings),
  ) {
    this.disposables = [provider.onDidChange(() => this.cache.clear())];
  }

  /** User exec config for a context, or `undefined` if the context does not use exec auth. */
  execConfig(context: string): ExecConfig | undefined {
    const kc = this.provider.kubeConfig();
    const userName = kc.getContextObject(context)?.user;
    return userName ? execOf(kc.getUser(userName)) : undefined;
  }

  /**
   * Terminal sign-in is needed when a context uses exec auth (without `interactiveMode: Never`) and has no
   * valid credentials — or when the user clicks Reconnect (`reauthenticate`), which always reruns the plugin.
   */
  needsLogin(context: string, reauthenticate = false): boolean {
    const exec = this.execConfig(context);
    const user = this.userOf(context);
    return !!exec && !!user && exec.interactiveMode !== "Never" && (reauthenticate || !this.cached(user));
  }

  /** Sign in through an interactive terminal; `reauthenticate` discards cached credentials so the plugin prompts again. */
  async login(context: string, signal: AbortSignal, reauthenticate = false): Promise<void> {
    const exec = this.execConfig(context);
    const user = this.userOf(context);
    if (!exec || !user) return;
    // An ongoing background run may succeed (the plugin has its own cache); open a terminal only if it fails.
    const running = this.inflight.get(user);
    if (running) await abortable(running, signal).catch(() => signal.throwIfAborted());
    if (reauthenticate) this.cache.delete(user);
    await this.fetch(user, signal, () => this.runInTerminal(context, exec, signal));
  }

  /** Server returned 401 for cached credentials: discard them to rerun the plugin next time. */
  invalidate(context: string): void {
    const user = this.userOf(context);
    if (user) this.cache.delete(user);
  }

  /** Request credentials (from cache, or by running the plugin in the background). */
  credential(userName: string): Promise<ExecCredential> {
    const exec = execOf(this.provider.kubeConfig().getUser(userName));
    if (!exec) return Promise.reject(new Error(`User '${userName}' has no exec auth config`));
    const signal = AbortSignal.timeout(BACKGROUND_TIMEOUT_MS);
    return this.fetch(userName, signal, () => this.runInBackground(exec, signal));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private async fetch(user: string, signal: AbortSignal, run: () => Promise<ExecCredential>): Promise<ExecCredential> {
    const cached = this.cached(user);
    if (cached) return cached;
    let pending = this.inflight.get(user);
    if (!pending) {
      const current = run().then((credential) => {
        this.cache.set(user, credential);
        return credential;
      });
      const done = () => {
        if (this.inflight.get(user) === current) this.inflight.delete(user);
      };
      current.then(done, done);
      this.inflight.set(user, current);
      pending = current;
    }
    return abortable(pending, signal);
  }

  private cached(user: string): ExecCredential | undefined {
    const c = this.cache.get(user);
    const expires = c?.status.expirationTimestamp ? Date.parse(c.status.expirationTimestamp) : Number.POSITIVE_INFINITY;
    if (c && expires > Date.now() + 10_000) return c;
    this.cache.delete(user);
    return undefined;
  }

  private userOf(context: string): string | undefined {
    return this.provider.kubeConfig().getContextObject(context)?.user;
  }

  private env(exec: ExecConfig, interactive: boolean): Record<string, string> {
    const env: Record<string, string> = {};
    for (const e of exec.env ?? []) env[e.name] = e.value;
    const path = [...this.settings.extraPath(), env["PATH"] ?? process.env["PATH"] ?? ""].filter(Boolean);
    env["PATH"] = path.join(delimiter);
    env["KUBERNETES_EXEC_INFO"] = JSON.stringify({
      apiVersion: exec.apiVersion ?? "client.authentication.k8s.io/v1beta1",
      kind: "ExecCredential",
      spec: { interactive },
    });
    return env;
  }

  private runInBackground(exec: ExecConfig, signal: AbortSignal): Promise<ExecCredential> {
    return new Promise((resolve, reject) => {
      const child = spawn(exec.command, [...(exec.args ?? [])], {
        env: { ...process.env, ...this.env(exec, false) },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (e: NodeJS.ErrnoException) => reject(pluginError(exec, e, signal)));
      child.on("close", (code) => {
        if (signal.aborted) return;
        if (code !== 0) {
          reject(new KubeApiError(`Auth plugin '${exec.command}' failed: ${stderr.trim() || `exit ${code}`}`, 401));
          return;
        }
        try {
          resolve(parseCredential(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Write stdout (credentials) to a 0600 temporary file to keep tokens off the terminal; delete immediately after reading. */
  private async runInTerminal(context: string, exec: ExecConfig, signal: AbortSignal): Promise<ExecCredential> {
    const dir = await mkdtemp(join(tmpdir(), "k8s-view-auth-"));
    const out = join(dir, "credential.json");
    try {
      const terminal = vscode.window.createTerminal({
        name: vscode.l10n.t("Sign in: {0}", context),
        ...signInShell(out, exec.command, exec.args ?? []),
        env: this.env(exec, true),
        iconPath: new vscode.ThemeIcon("key"),
        isTransient: true,
      });
      terminal.show(true);
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const closed = vscode.window.onDidCloseTerminal((t) => {
          if (t !== terminal) return;
          closed.dispose();
          signal.removeEventListener("abort", onAbort);
          resolve(t.exitStatus?.code);
        });
        const onAbort = () => {
          closed.dispose();
          terminal.dispose();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (code !== 0) throw new KubeApiError(`Sign-in with '${exec.command}' failed (exit ${code ?? "?"}).`, 401);
      return parseCredential(await readFile(out, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function execOf(user: User | null): ExecConfig | undefined {
  const exec = (user?.exec ?? user?.authProvider?.config?.exec) as ExecConfig | undefined;
  return exec?.command ? exec : undefined;
}

function parseCredential(text: string): ExecCredential {
  const credential = JSON.parse(text.replace(/^﻿/, "")) as Partial<ExecCredential>;
  if (!credential.status) throw new KubeApiError("Auth plugin returned no credential status.", 401);
  return credential as ExecCredential;
}

function pluginError(exec: ExecConfig, e: NodeJS.ErrnoException, signal: AbortSignal): Error {
  if (signal.aborted && e.name === "AbortError")
    return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? new KubeApiError(`Auth plugin '${exec.command}' timed out. Use Retry in the Context panel to sign in.`, 401)
      : e;
  if (e.code === "ENOENT")
    return new KubeApiError(
      `Auth plugin '${exec.command}' was not found in PATH. Add its folder to the 'k8sView.extraPath' setting.`,
      undefined,
      "ENOENT",
    );
  return new KubeApiError(`Auth plugin '${exec.command}' failed: ${e.message}`, 401);
}

/** Shared promise (multiple requests await one plugin execution), with independent cancellation for each caller. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
