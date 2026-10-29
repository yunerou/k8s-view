import * as vscode from "vscode";
import type { CommandRegistry } from "../app/CommandRegistry";
import { type SnippetDraft, type SnippetParam, snippetCommand } from "../app/ConfigEdits";
import type { ContextService } from "../app/ContextService";
import type { ResourceSource } from "../app/ports/ResourceSource";
import { inputIds, splitCommandLine } from "../core/command/commandLine";
import { CommandSchema } from "../core/config/schema";
import type { ConfigWriter } from "./ConfigWriter";

export interface SnippetWizardDeps {
  readonly contexts: ContextService;
  readonly source: ResourceSource;
  readonly commands: CommandRegistry;
  readonly writer: ConfigWriter;
}

const STEPS = 5;

/**
 * "Create snippet" wizard: title → command line (`${input:<name>}` parameters) → how to fill each parameter → scope →
 * execution location. Write to user/workspace `snippets.json`, then open the file for further editing.
 */
export async function createSnippetWizard(d: SnippetWizardDeps): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create snippet (1/{0}): title", STEPS),
    placeHolder: vscode.l10n.t("e.g. Pods of an app"),
    validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t("Title is required")),
  });
  if (!title) return;

  const commandLine = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create snippet (2/{0}): command line", STEPS),
    value: "kubectl get pods -l app=${input:app}",
    valueSelection: [0, 0],
    prompt: vscode.l10n.t(
      "Parameters: ${input:<name>} (asked when running). Variables: ${namespace}, ${context}, ${timestamp}. kubectl/helm/flux get --context automatically.",
    ),
    validateInput: (v) => {
      if (!v.trim()) return vscode.l10n.t("Command line is required");
      try {
        splitCommandLine(v);
        return undefined;
      } catch (e) {
        return (e as Error).message;
      }
    },
  });
  if (!commandLine) return;

  const params: SnippetParam[] = [];
  for (const id of inputIds(commandLine)) {
    const param = await askParam(d, id);
    if (!param) return;
    params.push(param);
  }

  const usesNamespace = /\$\{namespace/.test(commandLine) || /^\s*(kubectl|helm|flux)\b/.test(commandLine);
  const targets = [
    {
      label: `$(symbol-namespace) ${vscode.l10n.t("Current namespace")}`,
      detail: vscode.l10n.t("${namespace} = namespace selected in the Context panel"),
      target: "namespace" as const,
    },
    {
      label: `$(server-environment) ${vscode.l10n.t("Whole context")}`,
      detail: vscode.l10n.t("Cluster-wide command (nodes, namespaces, CRDs…)"),
      target: "context" as const,
    },
  ];
  const target = await vscode.window.showQuickPick(usesNamespace ? targets : [...targets].reverse(), {
    title: vscode.l10n.t("Create snippet (3/{0}): scope", STEPS),
  });
  if (!target) return;

  const runIn = await vscode.window.showQuickPick(
    [
      {
        label: `$(terminal) ${vscode.l10n.t("Terminal")}`,
        detail: vscode.l10n.t("Output stays visible; good for get/describe/logs"),
        runIn: "terminal" as const,
      },
      {
        label: `$(sync) ${vscode.l10n.t("Background")}`,
        detail: vscode.l10n.t("Progress notification; output in the 'K8s View: Commands' channel"),
        runIn: "process" as const,
      },
    ],
    { title: vscode.l10n.t("Create snippet (4/{0}): run in", STEPS) },
  );
  if (!runIn) return;

  const groups = [...new Set(d.commands.snippets().map((c) => c.group ?? "Snippets"))];
  const group = await pickGroup(groups);
  if (group === undefined) return;

  const draft: SnippetDraft = {
    id: uniqueId(d.commands, `snippet.${idPart(title)}`),
    title: title.trim(),
    ...(group ? { group } : {}),
    commandLine,
    target: target.target,
    runIn: runIn.runIn,
    params,
    platform: process.platform,
  };
  const command = snippetCommand(draft);
  const parsed = CommandSchema.safeParse(command);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? vscode.l10n.t("Invalid snippet"));
  await d.writer.createSnippet(command);
}

async function askParam(d: SnippetWizardDeps, id: string): Promise<SnippetParam | undefined> {
  type Item = vscode.QuickPickItem & { type: "text" | "secret" | "options" | "resource" };
  const picked = await vscode.window.showQuickPick<Item>(
    [
      {
        label: `$(edit) ${vscode.l10n.t("Text")}`,
        detail: vscode.l10n.t("Type a value (last value is offered)"),
        type: "text",
      },
      { label: `$(list-selection) ${vscode.l10n.t("Choose from a list…")}`, type: "options" },
      {
        label: `$(symbol-class) ${vscode.l10n.t("Name of a resource…")}`,
        detail: vscode.l10n.t("e.g. pick a Deployment of the current namespace"),
        type: "resource",
      },
      {
        label: `$(lock) ${vscode.l10n.t("Secret text")}`,
        detail: vscode.l10n.t("Masked, never remembered"),
        type: "secret",
      },
    ],
    { title: vscode.l10n.t("Create snippet: how is '{0}' filled?", id) },
  );
  if (!picked) return undefined;
  switch (picked.type) {
    case "text":
      return { id, type: "text" };
    case "secret":
      return { id, type: "text", secret: true };
    case "options": {
      const text = await vscode.window.showInputBox({
        title: vscode.l10n.t("Options for '{0}' (comma separated)", id),
        placeHolder: "10, 100, 1000",
        validateInput: (v) => (splitList(v).length > 0 ? undefined : vscode.l10n.t("Enter at least one option")),
      });
      return text ? { id, type: "options", options: splitList(text) } : undefined;
    }
    case "resource": {
      const ctx = d.contexts.current;
      if (!ctx) throw new Error(vscode.l10n.t("Select a context first"));
      const kinds = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Discovering kinds on {0}…", ctx.name) },
        () => d.source.listKinds(ctx),
      );
      const kind = await vscode.window.showQuickPick(
        kinds
          .sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind))
          .map((k) => ({ label: k.kind, description: k.group || "core", resourceKind: k })),
        { title: vscode.l10n.t("'{0}' is the name of which kind?", id), matchOnDescription: true },
      );
      return kind ? { id, type: "resource", group: kind.resourceKind.group, kind: kind.resourceKind.kind } : undefined;
    }
  }
}

async function pickGroup(existing: readonly string[]): Promise<string | undefined> {
  if (existing.length === 0) {
    return vscode.window.showInputBox({
      title: vscode.l10n.t("Create snippet (5/{0}): group", STEPS),
      value: "Snippets",
    });
  }
  const other = vscode.l10n.t("New group…");
  const picked = await vscode.window.showQuickPick([...existing, other], {
    title: vscode.l10n.t("Create snippet (5/{0}): group", STEPS),
  });
  if (picked !== other) return picked;
  return vscode.window.showInputBox({ title: vscode.l10n.t("Group name") });
}

function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function idPart(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "custom";
}

function uniqueId(commands: CommandRegistry, base: string): string {
  let id = base;
  for (let n = 2; commands.get(id); n++) id = `${base}-${n}`;
  return id;
}
