import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { stringify } from "yaml";
import { ContextService, errorMessage } from "../app/ContextService";
import { type ResourceLease, ResourceSource } from "../app/ports/ResourceSource";
import { Settings } from "../app/ports/Settings";
import { ClusterContext } from "../core/context/ClusterContext";
import { capture } from "../infra/exec/capture";
import { pathToRef, type ResourceRefArg, refToPath } from "./ResourceRefs";

export const MANIFEST_SCHEME = "k8sview";
export const DESCRIBE_SCHEME = "k8sview-describe";

function contextOf(ref: ResourceRefArg): ClusterContext {
  return new ClusterContext(
    ref.context,
    "",
    "",
    ref.namespace ? { type: "single", name: ref.namespace } : { type: "all" },
    false,
  );
}

/** Read-only resource YAML (`k8sview:` scheme), updated automatically on watch changes. Secrets are always masked. */
@injectable()
export class ManifestDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly leases = new Map<string, ResourceLease>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly source = inject(ResourceSource)) {
    this.disposables = [
      source.onDidChange((c) => {
        for (const key of this.leases.keys()) {
          const ref = pathToRef(vscode.Uri.parse(key).path, ".yaml");
          if (ref && ref.context === c.context && `${ref.group}/${ref.kind}` === c.kindKey)
            this.changed.fire(vscode.Uri.parse(key));
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.leases.get(key)?.dispose();
        this.leases.delete(key);
      }),
    ];
  }

  async open(ref: ResourceRefArg): Promise<void> {
    const uri = vscode.Uri.from({ scheme: MANIFEST_SCHEME, path: refToPath(ref, ".yaml") });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = pathToRef(uri.path, ".yaml");
    if (!ref) return "# Invalid K8s View manifest URI";
    const ctx = contextOf(ref);
    try {
      const kind = await this.source.resolveKind(ctx, ref);
      if (!kind) return `# ${ref.kind} is not served by context ${ref.context}`;
      const key = uri.toString();
      if (!this.leases.has(key))
        this.leases.set(key, this.source.acquire(ctx, ref, kind.namespaced ? ref.namespace : undefined));
      const cached = this.source
        .lookup(ctx)
        .list(ref.group, ref.kind, ref.namespace)
        ?.find((r) => r.name === ref.name && r.namespace === ref.namespace);
      const resource = cached ?? (await this.source.get(ctx, kind, ref.namespace, ref.name));
      return stringify(resource.object, { lineWidth: 0 });
    } catch (e) {
      return `# Cannot load ${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}: ${errorMessage(e)}`;
    }
  }

  dispose(): void {
    for (const l of this.leases.values()) l.dispose();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}

/** `kubectl describe` output as a read-only document (`k8sview-describe:` scheme). */
@injectable()
export class DescribeDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly source = inject(ResourceSource),
    private readonly contexts = inject(ContextService),
    private readonly settings = inject(Settings),
  ) {}

  async open(ref: ResourceRefArg): Promise<void> {
    const uri = vscode.Uri.from({ scheme: DESCRIBE_SCHEME, path: refToPath(ref, ".txt"), query: String(Date.now()) });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = pathToRef(uri.path, ".txt");
    if (!ref) return "Invalid URI";
    const kind = await this.source.resolveKind(contextOf(ref), ref).catch(() => undefined);
    const target = kind ? kind.kubectlName : ref.group ? `${ref.kind}.${ref.group}` : ref.kind;
    const args = [
      "describe",
      target,
      ref.name,
      "--context",
      ref.context,
      ...(ref.namespace ? ["-n", ref.namespace] : []),
    ];
    const delimiter = process.platform === "win32" ? ";" : ":";
    const env = {
      KUBECONFIG: this.contexts.kubeconfigEnv(),
      PATH: [...this.settings.extraPath(), process.env["PATH"] ?? ""].filter(Boolean).join(delimiter),
    };
    const result = await capture("kubectl", args, env);
    return result.code === 0 ? result.stdout : `$ kubectl ${args.join(" ")}\n\n${result.stderr || result.stdout}`;
  }
}
