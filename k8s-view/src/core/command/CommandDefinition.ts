import type { ConfigOrigin } from "../config/origin";
import type { CommandConfig, InputConfig, MatchConfig, RunConfig } from "../config/schema";
import {
  type CompiledPath,
  type CompiledTemplate,
  type ExpressionEngine,
  ExpressionError,
} from "../expression/ExpressionEngine";
import { COMMAND_VARIABLES, RESOURCE_VARIABLES } from "../expression/variables";
import type { KubeResource } from "../resource/KubeResource";
import { hashString, stableStringify } from "../util/hash";
import { CompiledFilter } from "../view/Filter";
import type { CompileIssue, ConfigPath } from "../view/ViewDefinition";
import type { CommandAllowlist } from "./allowlist";

const VARIABLES = [...RESOURCE_VARIABLES, ...COMMAND_VARIABLES];

interface CompiledMatch {
  readonly config: MatchConfig;
  readonly when: CompiledFilter | undefined;
}

/** Compiled `run` templates (args, cwd, env, name; vscode args are a JSON tree). */
export interface CompiledRun {
  readonly config: RunConfig;
  readonly args: readonly CompiledTemplate[];
  readonly cwd: CompiledTemplate | undefined;
  readonly env: readonly (readonly [string, CompiledTemplate])[];
  readonly name: CompiledTemplate | undefined;
  readonly vscodeArgs: unknown;
}

export class CommandDefinition {
  readonly hash: string;

  constructor(
    readonly config: CommandConfig,
    readonly origin: ConfigOrigin,
    private readonly matchers: readonly CompiledMatch[],
    readonly run: CompiledRun,
    readonly confirmTemplate: CompiledTemplate | undefined,
    readonly inputs: readonly {
      config: InputConfig;
      from: CompiledPath | undefined;
      default: CompiledTemplate | undefined;
    }[],
    /** Present when `run` originates from remote config: rendered argv must match before execution. */
    readonly allowlist?: CommandAllowlist,
  ) {
    this.hash = hashString(stableStringify(config));
  }

  get id(): string {
    return this.config.id;
  }
  get title(): string {
    return this.config.title;
  }
  get group(): string | undefined {
    return this.config.group;
  }
  get icon(): string | undefined {
    return this.config.icon;
  }
  get target(): CommandConfig["target"] {
    return this.config.target;
  }
  get isSnippet(): boolean {
    return this.config.target !== "resource";
  }
  get dangerous(): boolean {
    return this.config.dangerous;
  }
  get multi(): CommandConfig["multi"] {
    return this.config.multi;
  }
  get isBatch(): boolean {
    return this.config.run.type === "batch";
  }
  get refreshAfter(): boolean {
    return this.config.refreshAfter;
  }
  /** Effective only in user config files; third-party repositories cannot disable your confirmations. */
  get skipConfirm(): boolean {
    return this.origin === "user" && this.config.skipConfirm;
  }

  matches(resource: KubeResource): boolean {
    if (this.isSnippet || !this.config.enabled) return false;
    return this.matchers.some(
      (m) =>
        (m.config.group === "*" || m.config.group === resource.kind.group) &&
        (m.config.kind === "*" || m.config.kind === resource.kind.kind) &&
        (m.when?.test(resource) ?? true),
    );
  }

  /** Kinds the command can apply to (excluding `when`), for quick menu filtering. */
  appliesToKind(group: string, kind: string): boolean {
    return this.matchers.some(
      (m) => (m.config.group === "*" || m.config.group === group) && (m.config.kind === "*" || m.config.kind === kind),
    );
  }
}

export function compileCommand(
  config: CommandConfig,
  origin: ConfigOrigin,
  engine: ExpressionEngine,
  allowlist?: CommandAllowlist,
): { command: CommandDefinition | undefined; issues: CompileIssue[] } {
  const issues: CompileIssue[] = [];
  const attempt = <T>(path: ConfigPath, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ExpressionError || e instanceof SyntaxError) {
        issues.push({ path, message: e.message });
        return undefined;
      }
      throw e;
    }
  };
  const tpl = (source: string, path: ConfigPath) =>
    attempt(path, () => engine.compileTemplate(source, { variables: VARIABLES }));

  const matchers = config.match.map((m, i) => ({
    config: m,
    when: m.when === undefined ? undefined : attempt(["match", i, "when"], () => new CompiledFilter(m.when!, engine)),
  }));
  const run = config.run;
  const args = "args" in run && run.type !== "vscode" ? run.args.map((a, i) => tpl(a, ["run", "args", i])) : [];
  if (run.type === "batch" && run.replicas !== undefined) args.push(tpl(run.replicas, ["run", "replicas"]));
  const cwd = "cwd" in run && run.cwd !== undefined ? tpl(run.cwd, ["run", "cwd"]) : undefined;
  const env =
    "env" in run && run.env ? Object.entries(run.env).map(([k, v]) => [k, tpl(v, ["run", "env", k])] as const) : [];
  const name = run.type === "terminal" && run.name !== undefined ? tpl(run.name, ["run", "name"]) : undefined;
  const vscodeArgs = run.type === "vscode" ? compileTree(run.args, ["run", "args"], tpl) : undefined;
  const confirm = config.confirm === undefined ? undefined : tpl(config.confirm, ["confirm"]);
  const inputs = config.inputs.map((input, i) => ({
    config: input,
    from:
      input.type === "pick" && input.from
        ? attempt(["inputs", i, "from"], () => engine.compilePath(input.from!))
        : undefined,
    default:
      input.type === "prompt" && input.default !== undefined ? tpl(input.default, ["inputs", i, "default"]) : undefined,
  }));

  if (issues.length > 0) return { command: undefined, issues };
  const compiledRun: CompiledRun = {
    config: run,
    args: args as CompiledTemplate[],
    cwd,
    env: env as [string, CompiledTemplate][],
    name,
    vscodeArgs,
  };
  return {
    command: new CommandDefinition(config, origin, matchers, compiledRun, confirm, inputs, allowlist),
    issues,
  };
}

function compileTree(
  value: unknown,
  path: ConfigPath,
  tpl: (s: string, p: ConfigPath) => CompiledTemplate | undefined,
): unknown {
  if (typeof value === "string") return tpl(value, path);
  if (Array.isArray(value)) return value.map((v, i) => compileTree(v, [...path, i], tpl));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compileTree(v, [...path, k], tpl)]));
  }
  return value;
}
