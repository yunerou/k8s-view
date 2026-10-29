import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { errorMessage } from "../app/ContextService";
import { ResourceSource } from "../app/ports/ResourceSource";
import { ClusterContext } from "../core/context/ClusterContext";
import { decodeSecretData } from "../core/resource/secretData";
import { pathToRef, type ResourceRefArg, refToPath } from "./ResourceRefs";
import { secretYaml } from "./secretYaml";

export const SECRET_SCHEME = "k8sview-secret";

/**
 * "Decrypt secret": base64-decoded values of all keys in a read-only document (`k8sview-secret:` scheme).
 * Read directly from the API server on each open, bypassing the store and never writing to disk; no automatic updates.
 */
@injectable()
export class SecretDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly source = inject(ResourceSource)) {}

  async open(ref: ResourceRefArg): Promise<void> {
    if (ref.group !== "" || ref.kind !== "Secret" || !ref.namespace)
      throw new Error(vscode.l10n.t("Decrypt works on Secrets only"));
    // New query on every open: VS Code does not reuse previously decrypted content.
    const uri = vscode.Uri.from({ scheme: SECRET_SCHEME, path: refToPath(ref, ".yaml"), query: String(Date.now()) });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = pathToRef(uri.path, ".yaml");
    if (!ref?.namespace) return "# Invalid K8s View secret URI";
    const ctx = new ClusterContext(ref.context, "", "", { type: "single", name: ref.namespace }, false);
    try {
      const secret = await this.source.readSecret(ctx, ref.namespace, ref.name);
      return secretYaml(ref, secret.type, decodeSecretData(secret.data));
    } catch (e) {
      return `# Cannot read Secret ${ref.namespace}/${ref.name}: ${errorMessage(e)}`;
    }
  }
}
