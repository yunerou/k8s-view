import type https from "node:https";
import { KubeConfig, type User } from "@kubernetes/client-node";
import { inject, injectable } from "@needle-di/core";
import type * as vscode from "vscode";
import { ExecCredentialProvider } from "./ExecCredentialProvider";
import { KubeConfigProvider } from "./KubeConfigProvider";

/** Use `authProvider.name` instead of `exec` so client-node's `ExecAuth` skips this user, delegating to `ExecCredentialProvider`. */
const EXEC_PROVIDER = "k8s-view-exec";

type Authenticator = Parameters<KubeConfig["addAuthenticator"]>[0];

/**
 * A separate `KubeConfig` per context (`setCurrentContext` on a copy), never modifying kubeconfig files.
 * Exec auth plugins (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`) run through `ExecCredentialProvider`
 * (PATH includes `k8sView.extraPath`, supports cancellation and interactive terminal sign-in).
 */
@injectable()
export class KubeClientFactory implements vscode.Disposable {
  private readonly configs = new Map<string, KubeConfig>();
  private readonly disposables: vscode.Disposable[];
  private readonly authenticator: Authenticator;

  constructor(
    private readonly provider = inject(KubeConfigProvider),
    credentials = inject(ExecCredentialProvider),
  ) {
    this.authenticator = execAuthenticator(credentials);
    this.disposables = [provider.onDidChange(() => this.configs.clear())];
  }

  config(context: string): KubeConfig {
    let kc = this.configs.get(context);
    if (!kc) {
      const base = this.provider.kubeConfig();
      if (!base.getContextObject(context)) throw new Error(`Context '${context}' not found in kubeconfig`);
      kc = new KubeConfig();
      kc.addAuthenticator(this.authenticator);
      kc.loadFromOptions({
        clusters: base.getClusters(),
        users: base.getUsers().map(withoutExec),
        contexts: base.getContexts(),
        currentContext: context,
      });
      this.configs.set(context, kc);
    }
    return kc;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function withoutExec(user: User): User {
  if (!user.exec && !user.authProvider?.config?.exec) return user;
  const { exec: _exec, ...rest } = user;
  return { ...rest, authProvider: { name: EXEC_PROVIDER } };
}

function execAuthenticator(credentials: ExecCredentialProvider): Authenticator {
  return {
    isAuthProvider: (user) => user.authProvider?.name === EXEC_PROVIDER,
    async applyAuthentication(user, opts) {
      const { status } = await credentials.credential(user.name);
      const o = opts as https.RequestOptions;
      if (status.clientCertificateData) o.cert = status.clientCertificateData;
      if (status.clientKeyData) o.key = status.clientKeyData;
      if (status.token) o.headers = { ...o.headers, Authorization: `Bearer ${status.token}` };
    },
  };
}
