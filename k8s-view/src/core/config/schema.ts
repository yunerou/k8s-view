import { z } from "zod";
import { HOTKEY_ACTIONS, parseChord } from "../../shared/hotkeys";

/**
 * K8s View config schema — single source for TypeScript types, runtime validation,
 * and `schemas/k8s-view.schema.json` (IntelliSense). Use `strictObject` to catch misspelled keys.
 */

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, '.', '_' or '-'");
const Template = z.string().describe("Template: ${name}, ${namespace}, ${label:<key>}, ${$.<jsonpath>}…");
const JsonPathString = z.string().describe("JSONPath, e.g. $.status.phase");

export const StatusLevelSchema = z.enum(["ok", "warning", "error", "progress", "unknown"]);
export type StatusLevel = z.infer<typeof StatusLevelSchema>;

export const ResourceRefSchema = z.strictObject({
  group: z.string().default("").describe('API group; "" is the core group'),
  kind: z.string().min(1),
  version: z.string().optional().describe("Omit to let discovery pick the preferred version"),
});
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const FilterOpSchema = z.enum(["eq", "neq", "in", "exists", "notExists", "regex", "ownedBy", "notOwnedBy"]);
const FilterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

export const FilterSchema = z
  .strictObject({
    path: JsonPathString.optional(),
    op: FilterOpSchema,
    value: FilterValue.optional(),
  })
  .superRefine((f, ctx) => {
    const ownerOp = f.op === "ownedBy" || f.op === "notOwnedBy";
    if (!ownerOp && f.path === undefined)
      ctx.addIssue({ code: "custom", message: `'path' is required for op '${f.op}'`, path: ["path"] });
    if (ownerOp && typeof f.value !== "string") {
      ctx.addIssue({
        code: "custom",
        message: `'value' must be an owner kind (e.g. "CronJob") for op '${f.op}'`,
        path: ["value"],
      });
    }
  });
export type FilterConfig = z.infer<typeof FilterSchema>;
export const FiltersSchema = z.union([FilterSchema, z.array(FilterSchema)]).describe("Several conditions = AND");

export const StatusPresetSchema = z.enum(["readyCondition", "pod", "replicas", "job"]);
export const StatusRuleSchema = z.strictObject({
  when: FiltersSchema,
  level: StatusLevelSchema,
  summary: z.string().optional().describe("Short status text shown in the tree description and tooltip"),
  icon: z.string().optional().describe("Codicon of the resource in the tree when this rule matches"),
  color: z
    .string()
    .optional()
    .describe('Theme color id of the tree icon (e.g. "disabledForeground"); defaults to the color of the level'),
});
export type StatusRuleConfig = z.infer<typeof StatusRuleSchema>;

export const StatusSchema = z.union([
  z.strictObject({ preset: StatusPresetSchema }),
  z.strictObject({
    rules: z.array(StatusRuleSchema).min(1),
    default: StatusLevelSchema.default("unknown"),
  }),
]);
export type StatusConfig = z.infer<typeof StatusSchema>;

export const RenderSchema = z.enum([
  "text",
  "age",
  "status",
  "boolean",
  "count",
  "labels",
  "quantity",
  "badge",
  "cpu",
  "memory",
  "percentage",
]);
export type RenderKind = z.infer<typeof RenderSchema>;

const ColumnBase = {
  id: Id.optional().describe("Defaults to the slug of title"),
  title: z.string().min(1),
  render: RenderSchema.default("text"),
  default: z.string().optional().describe("Text shown when the value is empty"),
  width: z.number().int().positive().optional(),
  hidden: z.boolean().default(false),
};

// path OR template: use a union instead of .refine, which is dropped during JSON Schema generation.
export const ColumnSchema = z.union([
  z.strictObject({ ...ColumnBase, path: JsonPathString }),
  z.strictObject({ ...ColumnBase, template: Template }),
]);
export type ColumnConfig = z.infer<typeof ColumnSchema>;

const Ref = z.strictObject({ path: JsonPathString.optional(), default: z.string() });

export const RelationSchema = z.discriminatedUnion("type", [
  // Child ownerReferences[].uid = parent UID (Deployment → ReplicaSet → Pod, CronJob → Job).
  z.strictObject({ type: z.literal("ownerRef"), group: z.string().default(""), kind: z.string() }),
  // Parent selector matches child labels; supports maps (Service) and matchLabels/matchExpressions.
  z.strictObject({
    type: z.literal("labelSelector"),
    group: z.string().default(""),
    kind: z.string(),
    selector: JsonPathString,
  }),
  // Parent references children: each `items` entry is a reference.
  z.strictObject({
    type: z.literal("fieldRef"),
    items: JsonPathString,
    group: Ref,
    kind: Ref,
    name: JsonPathString.default("$.name"),
    namespace: z
      .string()
      .default("$self")
      .describe('JSONPath on the reference item, or "$self" for the parent namespace'),
  }),
  // Child references parent (RoleBinding.subjects → ServiceAccount); match: parent template compared to item name/namespace.
  z.strictObject({
    type: z.literal("reverseFieldRef"),
    group: z.string(),
    kind: z.string(),
    items: JsonPathString,
    match: z.strictObject({ name: Template, namespace: Template.optional() }),
    allNamespaces: z
      .boolean()
      .default(false)
      .describe("Look for children in every namespace, not only the selected one"),
  }),
  // Expand an array within an object (containers, data keys).
  z.strictObject({
    type: z.literal("field"),
    items: JsonPathString,
    label: Template,
    description: Template.optional(),
    icon: z.string().optional(),
  }),
]);
export type RelationConfig = z.infer<typeof RelationSchema>;

const SortSchema = z.union([
  z.string(),
  z.strictObject({ by: z.string(), order: z.enum(["asc", "desc"]).default("asc") }),
]);
const GroupBySchema = z.string().describe('"kind", "namespace", "status", "label:<key>" or a JSONPath');

export interface ChildConfig {
  id?: string | undefined;
  title?: string | undefined;
  relation: RelationConfig;
  filter?: FilterConfig | FilterConfig[] | undefined;
  status?: StatusConfig | undefined;
  label?: string | undefined;
  description?: string | undefined;
  hidden: boolean;
  children: ChildConfig[];
}

export const ChildSchema: z.ZodType<ChildConfig, unknown> = z.strictObject({
  id: Id.optional(),
  title: z.string().optional(),
  relation: RelationSchema,
  filter: FiltersSchema.optional(),
  status: StatusSchema.optional(),
  label: Template.optional().describe("Label in the tree instead of the resource name"),
  description: Template.optional(),
  hidden: z.boolean().default(false),
  get children() {
    return z.array(ChildSchema).default([]);
  },
});

const SectionFields = {
  id: Id,
  title: z.string().min(1),
  icon: z.string().optional().describe("Codicon name"),
  resources: z.array(ResourceRefSchema).min(1),
  filter: FiltersSchema.optional(),
  columns: z.array(ColumnSchema).default([]),
  status: StatusSchema.optional(),
  label: Template.optional().describe("Label in the tree instead of the resource name"),
  description: Template.optional().describe("Shown next to the name in the tree"),
  children: z.array(ChildSchema).default([]),
  groupBy: GroupBySchema.optional(),
  sort: SortSchema.optional(),
  allNamespaces: z
    .boolean()
    .default(false)
    .describe("List the resources of every namespace, whatever namespace is selected"),
  hidden: z.boolean().default(false),
};
export const SectionSchema = z.strictObject(SectionFields);
export type SectionConfig = z.infer<typeof SectionSchema>;

const ViewFields = {
  id: Id,
  title: z.string().min(1),
  icon: z.string().optional().describe("Codicon name"),
  requires: z.array(z.string()).optional().describe("API groups that must exist on the cluster"),
  enabled: z.boolean().default(true),
  order: z.number().optional(),
  portForwards: z
    .boolean()
    .default(false)
    .describe("Show the running port-forwards of the context at the top of the view"),
  sections: z.array(SectionSchema).min(1),
};
export const ViewSchema = z.strictObject(ViewFields);
export type ViewConfig = z.infer<typeof ViewSchema>;

const Remove = { remove: z.boolean().optional().describe("Remove the inherited item with this id") };
const ColumnPatchSchema = z.strictObject({
  id: Id.optional(),
  title: z.string().optional(),
  render: RenderSchema.optional(),
  default: z.string().optional(),
  width: z.number().int().positive().optional(),
  hidden: z.boolean().optional(),
  path: JsonPathString.optional(),
  template: Template.optional(),
  ...Remove,
});
const ChildPatchSchema = z.looseObject({ id: Id.optional(), ...Remove });
const SectionPatchSchema = z.strictObject({
  id: Id,
  title: z.string().optional(),
  icon: z.string().optional(),
  resources: z.array(ResourceRefSchema).optional(),
  filter: FiltersSchema.optional(),
  columns: z.array(ColumnPatchSchema).optional(),
  status: StatusSchema.optional(),
  label: Template.optional(),
  description: Template.optional(),
  children: z.array(ChildPatchSchema).optional(),
  groupBy: GroupBySchema.optional(),
  sort: SortSchema.optional(),
  allNamespaces: z.boolean().optional(),
  hidden: z.boolean().optional(),
  ...Remove,
});

/** View override: deep merge onto a previously loaded `extends` view; arrays merge by `id`. */
export const ViewPatchSchema = z.strictObject({
  extends: Id,
  id: Id.optional().describe("Defaults to the extended id"),
  title: z.string().optional(),
  icon: z.string().optional(),
  requires: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  order: z.number().optional(),
  portForwards: z.boolean().optional(),
  sections: z.array(SectionPatchSchema).optional(),
});
export type ViewPatchConfig = z.infer<typeof ViewPatchSchema>;

export const InputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: Id,
    type: z.literal("pick"),
    title: z.string(),
    from: JsonPathString.optional().describe("JSONPath on the resource producing the options"),
    fromKind: z
      .strictObject({ group: z.string().default(""), kind: z.string().min(1) })
      .optional()
      .describe("Pick the name of a resource of this kind in the namespace (works for snippets)"),
    options: z.array(z.string()).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    id: Id,
    type: z.literal("prompt"),
    title: z.string(),
    default: Template.optional().describe("Initial value; without it the last value entered is offered"),
    placeholder: z.string().optional(),
    pattern: z.string().optional().describe("Regular expression the value must match"),
    secret: z.boolean().default(false).describe("Mask the value while typing and never remember it"),
  }),
  z.strictObject({ id: Id, type: z.literal("confirm"), title: Template }),
]);
export type InputConfig = z.infer<typeof InputSchema>;

const Args = z.array(Template).default([]);
const Env = z.record(z.string(), Template).optional();
export const RunSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("process"),
    command: z.string().min(1),
    args: Args,
    cwd: Template.optional(),
    env: Env,
  }),
  z.strictObject({
    type: z.literal("terminal"),
    command: z.string().min(1),
    args: Args,
    cwd: Template.optional(),
    env: Env,
    name: Template.optional(),
  }),
  z.strictObject({ type: z.literal("kubectl"), args: Args }),
  z.strictObject({ type: z.literal("vscode"), command: z.string().min(1), args: z.array(z.unknown()).default([]) }),
  z.strictObject({
    type: z.literal("batch"),
    operation: z.enum([
      "copyNames",
      "delete",
      "restart",
      "scale",
      "suspend",
      "resume",
      "trigger",
      "cordon",
      "uncordon",
    ]),
    replicas: Template.optional(),
  }),
]);
export type RunConfig = z.infer<typeof RunSchema>;

export const MatchSchema = z.strictObject({
  group: z.string().default(""),
  kind: z.string().describe('Kind, or "*" for any kind'),
  when: FiltersSchema.optional(),
});
export type MatchConfig = z.infer<typeof MatchSchema>;

const CommandFields = {
  id: Id,
  title: z.string().min(1),
  group: z.string().optional(),
  icon: z.string().optional(),
  target: z.enum(["resource", "namespace", "context"]).default("resource"),
  match: z.array(MatchSchema).default([]),
  inputs: z.array(InputSchema).default([]),
  run: RunSchema,
  multi: z.enum(["none", "sequential", "parallel"]).default("none"),
  refreshAfter: z.boolean().default(false),
  dangerous: z.boolean().default(false),
  confirm: Template.optional().describe("Message of the confirmation dialog"),
  skipConfirm: z.boolean().default(false).describe("Only honoured in user config files"),
  enabled: z.boolean().default(true),
  order: z.number().optional(),
};
export const CommandSchema = z.strictObject(CommandFields);
export type CommandConfig = z.infer<typeof CommandSchema>;

export const CommandPatchSchema = z.strictObject({
  extends: Id,
  id: Id.optional(),
  title: z.string().optional(),
  group: z.string().optional(),
  icon: z.string().optional(),
  match: z.array(MatchSchema).optional(),
  inputs: z.array(InputSchema).optional(),
  run: RunSchema.optional(),
  multi: z.enum(["none", "sequential", "parallel"]).optional(),
  refreshAfter: z.boolean().optional(),
  dangerous: z.boolean().optional(),
  confirm: Template.optional(),
  skipConfirm: z.boolean().optional(),
  enabled: z.boolean().optional(),
  order: z.number().optional(),
});
export type CommandPatchConfig = z.infer<typeof CommandPatchSchema>;

const HOTKEY_TARGETS = ["action", "view", "favorite", "namespace", "allNamespaces", "command"] as const;

export const HotkeyBindingSchema = z
  .strictObject({
    key: z
      .string()
      .refine((k) => parseChord(k) !== undefined, {
        message: "Unknown key: use e.g. 'g', 'shift+1', 'ctrl+alt+k', '?', '[', 'f5', 'esc'",
      })
      .describe("Key chord: modifiers (ctrl, alt/option, shift, cmd/meta) joined with '+', e.g. 'shift+1', 'cmd+r'"),
    action: z.enum(HOTKEY_ACTIONS).optional().describe("Built-in table action; 'none' removes a default binding"),
    view: Id.optional().describe("Switch the table to this view id"),
    favorite: z
      .number()
      .int()
      .min(1)
      .max(9)
      .optional()
      .describe("Switch to favorite view N (1-9) of the setting k8sView.views.favorites"),
    namespace: z.string().optional().describe("Select this namespace"),
    allNamespaces: z.literal(true).optional().describe("Select all namespaces"),
    command: Id.optional().describe("Run this command id on the selected rows"),
  })
  .refine((b) => HOTKEY_TARGETS.filter((t) => b[t] !== undefined).length === 1, {
    message: `Set exactly one of ${HOTKEY_TARGETS.join(", ")}`,
  });
export type HotkeyBindingConfig = z.infer<typeof HotkeyBindingSchema>;

export const HotkeysSchema = z
  .strictObject({
    bindings: z.array(HotkeyBindingSchema).optional().describe("Table hotkeys; they replace defaults on the same key"),
  })
  .describe("Hotkeys of the table view, active when hotkey mode is ON (command 'K8s View: Toggle hotkeys')");

export const ConfigFileSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  views: z.array(z.union([ViewSchema, ViewPatchSchema])).default([]),
  commands: z.array(z.union([CommandSchema, CommandPatchSchema])).default([]),
  hotkeys: HotkeysSchema.optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** File envelope: validate views/commands individually so one invalid entry does not invalidate the entire file. */
export const ConfigEnvelopeSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  views: z.array(z.unknown()).default([]),
  commands: z.array(z.unknown()).default([]),
  hotkeys: z.unknown().optional(),
});

/** `hotkeys` envelope: validate each binding individually. */
export const HotkeysEnvelopeSchema = z.strictObject({
  bindings: z.array(z.unknown()).default([]),
});

export function configJsonSchema(): object {
  const schema = z.toJSONSchema(ConfigFileSchema, { io: "input", unrepresentable: "any", target: "draft-7" });
  return { ...schema, title: "K8s View configuration", allowComments: true };
}
