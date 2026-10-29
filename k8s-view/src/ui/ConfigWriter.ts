import { homedir } from "node:os";
import { inject, injectable } from "@needle-di/core";
import { findNodeAtLocation, parse, parseTree } from "jsonc-parser";
import * as vscode from "vscode";
import type { CommandLocation } from "../app/CommandRegistry";
import {
  appendCommand,
  columnsPatch,
  customViewText,
  removeCommand,
  upsertSectionColumns,
  viewOverrideText,
} from "../app/ConfigEdits";
import { Settings } from "../app/ports/Settings";
import type { RegisteredView } from "../app/ViewRegistry";
import type { ResourceKind } from "../core/resource/ResourceKind";
import { splitGlob } from "../infra/config/glob";
import type { SectionPrefs } from "../shared/protocol";

/** Write user/workspace config files: "Save to config", "Edit view config", "Create custom view", snippets. */
@injectable()
export class ConfigWriter {
  constructor(private readonly settings = inject(Settings)) {}

  async saveColumns(view: RegisteredView, sectionId: string, prefs: SectionPrefs): Promise<string | undefined> {
    const section = view.definition.config.sections.find((s) => s.id === sectionId);
    if (!section) return undefined;
    const own = view.origin === "user" || view.origin === "workspace" ? vscode.Uri.parse(view.fileId) : undefined;
    const target = own ?? (await this.pickTarget(`${view.id}.json`));
    if (!target) return undefined;
    const text = await read(target);
    const entry =
      text === undefined
        ? undefined
        : ((parse(text) as { views?: { id?: string; extends?: string }[] } | undefined)?.views ?? []).find(
            (v) => v.extends === view.id || v.id === view.id,
          );
    const mode = entry && entry.extends === undefined ? "full" : "extends";
    await write(target, upsertSectionColumns(text, view.id, sectionId, columnsPatch(section, prefs, mode)));
    return target.fsPath;
  }

  async editView(view: RegisteredView): Promise<void> {
    if (view.origin === "user" || view.origin === "workspace") {
      await openAt(vscode.Uri.parse(view.fileId), ["views", view.index]);
      return;
    }
    const target = await this.pickTarget(`${view.id}.json`);
    if (!target) return;
    const text = await read(target);
    if (text === undefined) await write(target, viewOverrideText(view.id));
    await openAt(target, ["views", 0]);
  }

  /** `true` if the file was written (the user did not cancel). */
  async createView(id: string, title: string, kinds: readonly ResourceKind[]): Promise<boolean> {
    const target = await this.pickTarget(`${id}.json`);
    if (!target) return false;
    if ((await read(target)) !== undefined) {
      const overwrite = vscode.l10n.t("Overwrite");
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("{0} already exists.", target.fsPath),
        { modal: true },
        overwrite,
      );
      if (answer !== overwrite) return false;
    }
    await write(target, customViewText(id, title, kinds));
    await openAt(target, ["views", 0]);
    return true;
  }

  /** Append a snippet to `snippets.json` (user or workspace), then open the file at the snippet; `false` if canceled. */
  async createSnippet(command: object): Promise<boolean> {
    const target = await this.pickTarget("snippets.json");
    if (!target) return false;
    const { text, index } = appendCommand(await read(target), command);
    await write(target, text);
    await openAt(target, ["commands", index]);
    return true;
  }

  /** Open the file at the command's declaration (user/workspace files only). */
  async editCommand(location: CommandLocation): Promise<void> {
    await openAt(vscode.Uri.parse(location.fileId), ["commands", location.index]);
  }

  async deleteCommand(location: CommandLocation): Promise<void> {
    const uri = vscode.Uri.parse(location.fileId);
    const text = await read(uri);
    if (text === undefined) throw new Error(vscode.l10n.t("Cannot read {0}", uri.fsPath));
    await write(uri, removeCommand(text, location.index));
  }

  private async pickTarget(fileName: string): Promise<vscode.Uri | undefined> {
    const pattern = this.settings.configFiles()[0] ?? "~/.config/k8s-view/*.json";
    const userDir = splitGlob(pattern, homedir()).dir;
    const items: (vscode.QuickPickItem & { uri: vscode.Uri })[] = [
      {
        label: "$(account) User",
        description: `${userDir}/${fileName}`,
        uri: vscode.Uri.joinPath(vscode.Uri.file(userDir), fileName),
      },
    ];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      items.push({
        label: "$(repo) Workspace",
        description: `.vscode/k8s-view/${fileName}`,
        detail: vscode.workspace.isTrusted
          ? undefined
          : vscode.l10n.t("Commands in workspace files only run in trusted workspaces"),
        uri: vscode.Uri.joinPath(folder.uri, ".vscode", "k8s-view", fileName),
      } as vscode.QuickPickItem & { uri: vscode.Uri });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Where should the configuration be saved?"),
    });
    return picked?.uri;
  }
}

async function read(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function write(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

async function openAt(uri: vscode.Uri, path: (string | number)[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const tree = parseTree(doc.getText());
  const node = tree ? findNodeAtLocation(tree, path) : undefined;
  const selection = node ? new vscode.Range(doc.positionAt(node.offset), doc.positionAt(node.offset)) : undefined;
  await vscode.window.showTextDocument(doc, selection ? { selection } : {});
}
