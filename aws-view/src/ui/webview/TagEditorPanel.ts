import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { Messenger } from "vscode-messenger";
import { InstanceService } from "../../app/InstanceService";
import { Selection } from "../../app/Selection";
import { type Instance, instanceLabel } from "../../core/ec2/model";
import { EXTENSION_CONTEXT } from "../../di/tokens";
import { TAG_EDITOR_VIEW_TYPE, type TagEditorInit, TagRequests } from "../../shared/protocol";
import { editableRows, isAwsTag } from "../../shared/tags";
import { webviewHtml, webviewOptions } from "./html";

/** One tag editor tab per instance; opening it again focuses the existing tab. */
@injectable()
export class TagEditorPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extension = inject(EXTENSION_CONTEXT),
    private readonly instances = inject(InstanceService),
    private readonly selection = inject(Selection),
  ) {}

  open(instance: Instance): void {
    const target = this.selection.target();
    if (!target) return;
    const key = JSON.stringify([target.profile, target.region, instance.id]);
    const isCurrentTarget = () => {
      const current = this.selection.target();
      return current?.profile === target.profile && current.region === target.region;
    };
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const uri = this.extension.extensionUri;
    const title = `Tags · ${instanceLabel(instance)}`;
    const panel = vscode.window.createWebviewPanel(TAG_EDITOR_VIEW_TYPE, title, vscode.ViewColumn.Active, {
      ...webviewOptions(uri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = new vscode.ThemeIcon("tag");
    panel.webview.html = webviewHtml(panel.webview, uri, "tags", title);
    const m = new Messenger();
    m.registerWebviewPanel(panel);
    // Close after the response has been posted to the webview.
    const close = () => setTimeout(() => panel.dispose(), 0);
    const subs = [
      m.onRequest(TagRequests.getInit, (): TagEditorInit => {
        const current = (isCurrentTarget() ? this.instances.get(instance.id) : undefined) ?? instance;
        return {
          instanceId: current.id,
          label: instanceLabel(current),
          rows: editableRows(current.tags),
          readOnlyCount: Object.keys(current.tags).filter(isAwsTag).length,
        };
      }),
      m.onRequest(TagRequests.save, async ({ rows }) => {
        if (!isCurrentTarget()) {
          return { error: "The AWS profile or region changed. Reopen the tag editor for the selected instance." };
        }
        const error = await this.instances.saveTags(instance.id, rows);
        if (error) return { error };
        close();
        return {};
      }),
      m.onRequest(TagRequests.cancel, () => {
        close();
      }),
    ];
    panel.onDidDispose(() => {
      for (const s of subs) s.dispose();
      this.panels.delete(key);
    });
    this.panels.set(key, panel);
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
  }
}
