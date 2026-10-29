import { CompiledTemplate, type TemplateContext } from "../expression/ExpressionEngine";
import { resourceVariable } from "../expression/variables";
import type { KubeResource } from "../resource/KubeResource";
import type { CommandDefinition } from "./CommandDefinition";

/** Variables supplied by the executor (selected context, kubeconfig, user inputs, etc.). */
export interface CommandVariables {
  readonly context: string;
  readonly cluster: string;
  readonly user: string;
  readonly kubeconfig: string;
  readonly timestamp: string;
  readonly workspaceFolder: string | undefined;
  /** Selected namespace; used for `target: namespace` snippets (resources use their own namespace). */
  readonly namespace: string | undefined;
  readonly inputs: Readonly<Record<string, string>>;
}

export type RenderedRun =
  | {
      readonly type: "batch";
      readonly operation: Extract<CommandDefinition["run"]["config"], { type: "batch" }>["operation"];
      readonly replicas?: string;
    }
  | {
      readonly type: "process" | "terminal";
      readonly command: string;
      readonly args: string[];
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly name?: string;
    }
  | { readonly type: "kubectl"; readonly args: string[] }
  | { readonly type: "vscode"; readonly command: string; readonly args: unknown[] };

export function commandContext(resource: KubeResource | undefined, vars: CommandVariables): TemplateContext {
  return {
    root: resource?.object ?? {},
    variable(name, arg) {
      switch (name) {
        case "context":
        case "cluster":
        case "user":
        case "kubeconfig":
        case "timestamp":
          return vars[name];
        case "workspaceFolder":
          return vars.workspaceFolder;
        case "input":
          return arg === undefined ? undefined : vars.inputs[arg];
        case "namespace":
          return resource ? (resource.namespace ?? "") : vars.namespace;
        case "namespaceFlag": {
          // A single argument for kubectl/helm: All namespaces → `--all-namespaces`.
          const ns = resource ? resource.namespace : vars.namespace;
          return ns ? `--namespace=${ns}` : "--all-namespaces";
        }
        default:
          return resource ? resourceVariable(resource, name, arg) : undefined;
      }
    },
  };
}

/** Render templates into argv. Each args element is a whole argument: no whitespace splitting or shell execution. */
export function renderRun(
  command: CommandDefinition,
  resource: KubeResource | undefined,
  vars: CommandVariables,
): RenderedRun {
  const ctx = commandContext(resource, vars);
  const run = command.run;
  const cfg = run.config;
  const args = run.args.map((t) => t.render(ctx));
  switch (cfg.type) {
    case "batch":
      return { type: "batch", operation: cfg.operation, ...(args[0] !== undefined ? { replicas: args[0] } : {}) };
    case "kubectl":
      return { type: "kubectl", args };
    case "vscode":
      return { type: "vscode", command: cfg.command, args: renderTree(run.vscodeArgs, ctx) as unknown[] };
    default: {
      const out: {
        type: "process" | "terminal";
        command: string;
        args: string[];
        cwd?: string;
        env?: Record<string, string>;
        name?: string;
      } = {
        type: cfg.type,
        command: cfg.command,
        args,
      };
      if (run.cwd) out.cwd = run.cwd.render(ctx);
      if (run.env.length > 0) out.env = Object.fromEntries(run.env.map(([k, t]) => [k, t.render(ctx)]));
      if (run.name) out.name = run.name.render(ctx);
      return out;
    }
  }
}

function renderTree(value: unknown, ctx: TemplateContext): unknown {
  if (value instanceof CompiledTemplate) return value.render(ctx);
  if (Array.isArray(value)) return value.map((v) => renderTree(v, ctx));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTree(v, ctx)]));
  return value;
}

const SAFE_POSIX = /^[A-Za-z0-9_\-./:=@,+%]+$/;

/** Quote an argument for the `kubectl` type (the MS extension joins arguments into a string and runs it through a shell). */
export function quoteArg(arg: string, platform: NodeJS.Platform | string): string {
  if (platform === "win32") {
    if (arg !== "" && /^[A-Za-z0-9_\-./:=@,+%\\]+$/.test(arg)) return arg;
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }
  if (arg !== "" && SAFE_POSIX.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Command line shown in confirmation dialogs (always POSIX-quoted for readability). */
export function displayCommandLine(run: RenderedRun): string {
  switch (run.type) {
    case "batch":
      return `Batch ${run.operation}${run.replicas !== undefined ? ` (replicas=${run.replicas})` : ""}`;
    case "vscode":
      return `${run.command} ${JSON.stringify(run.args)}`;
    case "kubectl":
      return ["kubectl", ...run.args].map((a) => quoteArg(a, "linux")).join(" ");
    default:
      return [run.command, ...run.args].map((a) => quoteArg(a, "linux")).join(" ");
  }
}
