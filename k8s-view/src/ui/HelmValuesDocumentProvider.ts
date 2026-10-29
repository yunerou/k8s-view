import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { stringify } from "yaml";
import { errorMessage } from "../app/ContextService";
import { ResourceSource } from "../app/ports/ResourceSource";
import { ClusterContext } from "../core/context/ClusterContext";
import {
  decodeHelmRelease,
  type HelmReleaseData,
  helmReleaseLocation,
  helmSecretName,
  latestHelmSecret,
} from "../core/helm/helmRelease";
import { pathToRef, type ResourceRefArg, refToPath } from "./ResourceRefs";

export const HELM_VALUES_SCHEME = "k8sview-helm";

/** `values`: applied user values; `defaults`: chart `values.yaml`. */
export type HelmValuesKind = "values" | "defaults";

const HELM_RELEASE_GROUP = "helm.toolkit.fluxcd.io";

/**
 * HelmRelease (Flux) "Show values" / "Show default values": read Helm releases from Helm storage Secrets, without the
 * `helm` CLI. Read-only documents, never saved to disk, reread on every open (values may contain sensitive data).
 */
@injectable()
export class HelmValuesDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly source = inject(ResourceSource)) {}

  async open(ref: ResourceRefArg, which: HelmValuesKind): Promise<void> {
    if (ref.group !== HELM_RELEASE_GROUP || ref.kind !== "HelmRelease" || !ref.namespace)
      throw new Error(vscode.l10n.t("Helm values work on Flux HelmReleases only"));
    const uri = vscode.Uri.from({
      scheme: HELM_VALUES_SCHEME,
      path: refToPath(ref, which === "defaults" ? ".defaults.yaml" : ".values.yaml"),
      query: String(Date.now()),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const which: HelmValuesKind = uri.path.endsWith(".defaults.yaml") ? "defaults" : "values";
    const ref = pathToRef(uri.path, which === "defaults" ? ".defaults.yaml" : ".values.yaml");
    if (!ref?.namespace) return "# Invalid K8s View Helm values URI";
    const ctx = new ClusterContext(ref.context, "", "", { type: "single", name: ref.namespace }, false);
    try {
      const release = await this.readRelease(ctx, ref);
      return render(ref, release, which);
    } catch (e) {
      return `# Cannot read the Helm release of HelmRelease ${ref.namespace}/${ref.name}: ${errorMessage(e)}`;
    }
  }

  private async readRelease(ctx: ClusterContext, ref: ResourceRefArg): Promise<HelmReleaseData> {
    const kind = await this.source.resolveKind(ctx, { group: HELM_RELEASE_GROUP, kind: "HelmRelease" });
    if (!kind) throw new Error(`HelmRelease is not served by context ${ctx.name}`);
    const hr = await this.source.get(ctx, kind, ref.namespace, ref.name);
    const location = helmReleaseLocation(hr.object);
    let secretName = location.revision !== undefined ? helmSecretName(location.release, location.revision) : undefined;
    if (!secretName) {
      const names = await this.source.listNames(ctx, { group: "", kind: "Secret" }, location.storageNamespace);
      secretName = latestHelmSecret(names, location.release);
    }
    if (!secretName)
      throw new Error(`no Helm release '${location.release}' stored in namespace ${location.storageNamespace}`);
    const secret = await this.source.readSecret(ctx, location.storageNamespace, secretName);
    const data = secret.data["release"];
    if (!data) throw new Error(`Secret ${location.storageNamespace}/${secretName} has no 'release' key`);
    return decodeHelmRelease(data);
  }
}

function render(ref: ResourceRefArg, release: HelmReleaseData, which: HelmValuesKind): string {
  const chart = [release.chartName, release.chartVersion].filter(Boolean).join(" ");
  const header = [
    `# HelmRelease ${ref.namespace}/${ref.name} — context ${ref.context}`,
    `# Helm release ${release.name}${release.revision !== undefined ? ` (revision ${release.revision})` : ""}` +
      `${release.namespace ? ` in ${release.namespace}` : ""}${chart ? ` — chart ${chart}` : ""}`,
    which === "defaults"
      ? "# Default values of the chart (values.yaml)."
      : "# Values applied by the last Helm install/upgrade (spec.values + valuesFrom). May contain secrets.",
    "# Read-only view, not saved to disk.",
  ];
  const values = which === "defaults" ? release.defaultValues : release.values;
  const body = Object.keys(values).length === 0 ? "{}\n" : stringify(values, { lineWidth: 0 });
  return `${header.join("\n")}\n${body}`;
}
