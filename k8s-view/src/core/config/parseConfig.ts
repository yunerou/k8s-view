import { findNodeAtLocation, type Node, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import type { z } from "zod";
import type { HotkeyAction, HotkeySpec } from "../../shared/hotkeys";
import {
  type CommandConfig,
  type CommandPatchConfig,
  CommandPatchSchema,
  CommandSchema,
  ConfigEnvelopeSchema,
  type HotkeyBindingConfig,
  HotkeyBindingSchema,
  HotkeysEnvelopeSchema,
  type ViewConfig,
  type ViewPatchConfig,
  ViewPatchSchema,
  ViewSchema,
} from "./schema";

export type JsonPathSegment = string | number;

export interface ConfigIssue {
  readonly message: string;
  readonly offset: number;
  readonly length: number;
  readonly path: readonly JsonPathSegment[];
  readonly severity: "error" | "warning";
}

export interface ConfigEntry<T> {
  /** Entry position in the file's `views`/`commands` array. */
  readonly index: number;
  readonly config: T;
}

export interface ParsedHotkeys {
  readonly bindings: readonly HotkeySpec[];
}

export interface ParsedConfig {
  readonly views: ConfigEntry<ViewConfig | ViewPatchConfig>[];
  readonly commands: ConfigEntry<CommandConfig | CommandPatchConfig>[];
  readonly hotkeys?: ParsedHotkeys;
  readonly issues: ConfigIssue[];
  /** JSONC tree for mapping later errors (expression compilation) back to source locations. */
  readonly tree: Node | undefined;
}

export function parseConfigText(text: string): ParsedConfig {
  const issues: ConfigIssue[] = [];
  if (text.trim() === "") {
    issues.push({ message: "Config file is empty", offset: 0, length: 0, path: [], severity: "error" });
    return { views: [], commands: [], issues, tree: undefined };
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  for (const e of errors) {
    issues.push({
      message: `JSON: ${printParseErrorCode(e.error)}`,
      offset: e.offset,
      length: e.length,
      path: [],
      severity: "error",
    });
  }
  if (!tree || errors.length > 0) return { views: [], commands: [], issues, tree };

  const raw = nodeValue(tree);
  const envelope = ConfigEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    issues.push(...zodIssues(tree, [], envelope.error));
    return { views: [], commands: [], issues, tree };
  }

  const views: ParsedConfig["views"] = [];
  envelope.data.views.forEach((item, index) => {
    const schema = isPatch(item) ? ViewPatchSchema : ViewSchema;
    const r = schema.safeParse(item);
    if (r.success) views.push({ index, config: r.data });
    else issues.push(...zodIssues(tree, ["views", index], r.error));
  });
  const commands: ParsedConfig["commands"] = [];
  envelope.data.commands.forEach((item, index) => {
    const schema = isPatch(item) ? CommandPatchSchema : CommandSchema;
    const r = schema.safeParse(item);
    if (r.success) commands.push({ index, config: r.data });
    else issues.push(...zodIssues(tree, ["commands", index], r.error));
  });
  const hotkeys = parseHotkeys(tree, envelope.data.hotkeys, issues);
  return { views, commands, ...(hotkeys ? { hotkeys } : {}), issues, tree };
}

function parseHotkeys(tree: Node, raw: unknown, issues: ConfigIssue[]): ParsedHotkeys | undefined {
  if (raw === undefined) return undefined;
  const envelope = HotkeysEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    issues.push(...zodIssues(tree, ["hotkeys"], envelope.error));
    return undefined;
  }
  const bindings: HotkeySpec[] = [];
  envelope.data.bindings.forEach((item, index) => {
    const r = HotkeyBindingSchema.safeParse(item);
    if (r.success) bindings.push({ key: r.data.key, action: hotkeyAction(r.data) });
    else issues.push(...zodIssues(tree, ["hotkeys", "bindings", index], r.error));
  });
  return { bindings };
}

/** Flat file format (`{ key, command }`) → action; the schema already ensures exactly one target. */
function hotkeyAction(b: HotkeyBindingConfig): HotkeyAction {
  if (b.action !== undefined) return { action: b.action };
  if (b.view !== undefined) return { view: b.view };
  if (b.favorite !== undefined) return { favorite: b.favorite };
  if (b.namespace !== undefined) return { namespace: b.namespace };
  if (b.allNamespaces) return { allNamespaces: true };
  return { command: b.command! };
}

function isPatch(item: unknown): boolean {
  return typeof item === "object" && item !== null && "extends" in item;
}

function nodeValue(node: Node): unknown {
  switch (node.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const prop of node.children ?? []) {
        const [key, value] = prop.children ?? [];
        if (key && value) out[String(key.value)] = nodeValue(value);
      }
      return out;
    }
    case "array":
      return (node.children ?? []).map(nodeValue);
    default:
      return node.value;
  }
}

function zodIssues(tree: Node, prefix: readonly JsonPathSegment[], error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = [...prefix, ...issue.path.filter((p): p is string | number => typeof p !== "symbol")];
    if (issue.code === "unrecognized_keys") {
      const key = issue.keys[0] ?? "";
      const keyNode = findNodeAtLocation(tree, [...path, key])?.parent?.children?.[0];
      return {
        message: `Unknown property ${issue.keys.map((k) => `'${k}'`).join(", ")}`,
        ...locate(keyNode ?? deepest(tree, path)),
        path,
        severity: "error" as const,
      };
    }
    return { message: issue.message, ...locate(deepest(tree, path)), path, severity: "error" as const };
  });
}

/** Deepest existing node on the path (missing required fields point to their parent object). */
export function deepest(tree: Node, path: readonly JsonPathSegment[]): Node {
  for (let n = path.length; n >= 0; n--) {
    const node = findNodeAtLocation(tree, path.slice(0, n) as JsonPathSegment[]);
    if (node) return node;
  }
  return tree;
}

export function locate(node: Node): { offset: number; length: number } {
  // Long objects/arrays: underline only the opening character for readability.
  if (node.type === "object" || node.type === "array") return { offset: node.offset, length: 1 };
  return { offset: node.offset, length: node.length };
}
