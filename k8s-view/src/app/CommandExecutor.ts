import { inject, injectable } from "@needle-di/core";
import type { CommandDefinition } from "../core/command/CommandDefinition";
import {
  type CommandVariables,
  commandContext,
  displayCommandLine,
  quoteArg,
  type RenderedRun,
  renderRun,
} from "../core/command/CommandTemplate";
import { decideExecution } from "../core/command/policy";
import type { ClusterContext } from "../core/context/ClusterContext";
import { stringify } from "../core/expression/ExpressionEngine";
import type { KubeResource } from "../core/resource/KubeResource";
import { ContextService, errorMessage } from "./ContextService";
import { Prompter } from "./ports/Prompter";
import { ResourceSource } from "./ports/ResourceSource";
import {
  BatchRunner,
  CommandInvoker,
  KubectlRunner,
  ProcessRunner,
  type ProcessSpec,
  TerminalRunner,
  WorkspaceInfo,
} from "./ports/Runners";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";

export type ExecutionResult = "ok" | "cancelled" | "blocked" | "failed";

export interface ExecuteOptions {
  /** Context differs from the selected one (MS Cluster Explorer nodes belong to kubeconfig's current-context). */
  readonly context?: ClusterContext;
}

export interface LastRun {
  readonly command: CommandDefinition;
  readonly targets: readonly KubeResource[];
  readonly options: ExecuteOptions;
  /** Execution context: switching contexts clears "Run last" to avoid sending old resource names to another cluster. */
  readonly context: string;
}

const APPROVED_KEY = "k8sView.approvedCommands";
/** Previously entered inputs, keyed by `<command id>/<input id>` (excluding `secret` inputs). */
const HISTORY_KEY = "k8sView.inputHistory";
const MAX_LINES_SHOWN = 5;

/** Execute a command: filter by resource, prompt for inputs, render argv, validate safety, run, refresh. */
@injectable()
export class CommandExecutor {
  lastRun: LastRun | undefined;
  /** Clock for `${timestamp}` (replaceable in tests). */
  now: () => Date = () => new Date();

  constructor(
    private readonly contexts = inject(ContextService),
    private readonly settings = inject(Settings),
    private readonly state = inject(StateStore),
    private readonly source = inject(ResourceSource),
    private readonly prompter = inject(Prompter),
    private readonly processes = inject(ProcessRunner),
    private readonly terminals = inject(TerminalRunner),
    private readonly kubectl = inject(KubectlRunner),
    private readonly invoker = inject(CommandInvoker),
    private readonly workspace = inject(WorkspaceInfo),
    private readonly batches = inject(BatchRunner),
  ) {
    this.contexts.onDidChange((ctx) => {
      if (this.lastRun && !this.lastRun.options.context && this.lastRun.context !== ctx?.name) this.lastRun = undefined;
    });
  }

  /** Rerun the last command; `targets` = newly selected resources (omitted = previous targets, for snippets). */
  async runLast(targets?: readonly KubeResource[]): Promise<ExecutionResult | undefined> {
    const last = this.lastRun;
    if (!last) return undefined;
    return targets ? this.execute(last.command, targets) : this.execute(last.command, last.targets, last.options);
  }

  async execute(
    command: CommandDefinition,
    targets: readonly KubeResource[],
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    const ctx = options.context ?? this.contexts.current;
    if (!ctx) {
      this.prompter.error("No Kubernetes context selected.");
      return "blocked";
    }
    if (command.origin === "workspace" && !this.workspace.isTrusted()) {
      this.prompter.blocked(
        `'${command.title}' comes from the workspace configuration and only runs in a trusted workspace.`,
      );
      return "blocked";
    }
    if ((command.origin === "workspace" || command.origin === "remote") && !(await this.approved(command))) {
      return "cancelled";
    }

    let resources: (KubeResource | undefined)[] = command.isSnippet
      ? [undefined]
      : targets.filter((t) => command.matches(t));
    if (resources.length === 0) {
      this.prompter.info(`'${command.title}' does not apply to the selected resource.`);
      return "cancelled";
    }
    if (command.isBatch && (resources.length !== targets.length || command.isSnippet)) {
      this.prompter.error("Batch commands must apply to every selected resource.");
      return "blocked";
    }
    if (!command.isBatch && command.multi === "none") resources = resources.slice(0, 1);

    const base: CommandVariables = {
      context: ctx.name,
      cluster: ctx.cluster,
      user: ctx.user,
      kubeconfig: this.contexts.kubeconfigEnv(),
      timestamp: timestamp(this.now()),
      workspaceFolder: this.workspace.folder(),
      namespace: ctx.namespace,
      inputs: {},
    };
    const inputs = await this.askInputs(command, resources[0], base, ctx);
    if (!inputs) return "cancelled";
    const vars = { ...base, inputs };
    const rendered = (command.isBatch ? resources.slice(0, 1) : resources).map((r) => ({
      resource: r,
      run: renderRun(command, r, vars),
    }));
    // Actual argv (after template substitution, before adding --context) must match the remote config's allowlist.
    const denied = command.allowlist && rendered.map((r) => command.allowlist!.check(r.run, ctx.name)).find(Boolean);
    if (denied) {
      this.prompter.blocked(`'${command.title}' (remote config) is blocked: ${denied}.`, "k8sView.remoteConfigs");
      return "blocked";
    }
    const runs = rendered.map((r) => ({ resource: r.resource, run: withContext(r.run, ctx.name) }));

    const decision = decideExecution({
      dangerous: command.dangerous,
      hasConfirm: command.confirmTemplate !== undefined,
      skipConfirm: command.skipConfirm,
      setting: this.settings.dangerousCommands(),
      contextProtected: ctx.isProtected,
    });
    if (decision.action === "block") {
      this.prompter.blocked(`'${command.title}' is a dangerous command. ${decision.reason}`);
      return "blocked";
    }
    if (decision.action === "confirm") {
      const message =
        command.confirmTemplate?.render(commandContext(resources[0], vars)) ??
        `Run '${command.title}' on context ${ctx.name}?`;
      // Do not show `secret` input values in confirmation dialogs.
      const secrets = command.inputs
        .filter((i) => i.config.type === "prompt" && i.config.secret)
        .map((i) => inputs[i.config.id])
        .filter((v): v is string => !!v);
      const lines = runs.map((r) => secrets.reduce((line, v) => line.split(v).join("••••"), displayCommandLine(r.run)));
      const detail = [
        `Context: ${ctx.name}${ctx.isProtected ? " (protected)" : ""}`,
        ...(command.isBatch
          ? [
              `Selected resources: ${resources.length}`,
              ...resources
                .slice(0, MAX_LINES_SHOWN)
                .map((r) => `${r!.kind.kind} ${r!.namespace ? `${r!.namespace}/` : ""}${r!.name}`),
              ...(resources.length > MAX_LINES_SHOWN ? [`… and ${resources.length - MAX_LINES_SHOWN} more`] : []),
            ]
          : []),
        "",
        ...lines.slice(0, MAX_LINES_SHOWN),
        ...(lines.length > MAX_LINES_SHOWN ? [`… and ${lines.length - MAX_LINES_SHOWN} more`] : []),
      ].join("\n");
      if (!(await this.prompter.confirm(message, detail, "Run"))) return "cancelled";
    }

    this.lastRun = { command, targets, options, context: ctx.name };
    const result = command.isBatch
      ? await this.runBatch(
          ctx.name,
          runs[0]!.run as Extract<RenderedRun, { type: "batch" }>,
          resources as KubeResource[],
          command.title,
        )
      : await this.run(command, runs);
    if (command.refreshAfter && (command.isBatch || result !== "cancelled")) {
      const refs = new Map(
        resources
          .filter((r): r is KubeResource => !!r)
          .map((r) => [r.kind.key, { group: r.kind.group, kind: r.kind.kind }]),
      );
      this.source.resync(ctx, [...refs.values()]);
      if (command.run.config.type === "batch" && command.run.config.operation === "trigger")
        this.source.resync(ctx, [{ group: "batch", kind: "Job" }]);
    }
    return result;
  }

  private async run(
    command: CommandDefinition,
    runs: { resource: KubeResource | undefined; run: RenderedRun }[],
  ): Promise<ExecutionResult> {
    const title = (r: KubeResource | undefined) => (r ? `${command.title}: ${r.name}` : command.title);
    const first = runs[0]!.run;
    switch (first.type) {
      case "batch":
        return "blocked";
      case "terminal":
        for (const { resource, run } of runs) {
          if (run.type !== "terminal") continue;
          this.terminals.open({ ...this.processSpec(title(resource), run), name: run.name ?? title(resource) });
        }
        return "ok";
      case "vscode":
        try {
          for (const { run } of runs) if (run.type === "vscode") await this.invoker.execute(run.command, run.args);
          return "ok";
        } catch (e) {
          this.prompter.error(`${command.title} failed: ${errorMessage(e)}`);
          return "failed";
        }
      case "kubectl": {
        const platform = this.workspace.platform();
        for (const { run } of runs) {
          if (run.type !== "kubectl") continue;
          const result = await this.kubectl.invoke(run.args.map((a) => quoteArg(a, platform)).join(" "));
          if (result?.code !== 0) {
            this.prompter.error(`${command.title} failed: ${result?.stderr.trim() || "kubectl is not available"}`);
            return "failed";
          }
        }
        this.prompter.info(`${command.title}: done`);
        return "ok";
      }
      case "process":
        return this.prompter.withProgress(command.title, async (token) => {
          const one = async ({ resource, run }: (typeof runs)[number]) =>
            run.type === "process" ? this.processes.run(this.processSpec(title(resource), run), token) : undefined;
          const outcomes = command.multi === "parallel" ? await Promise.all(runs.map(one)) : [];
          if (command.multi !== "parallel") {
            for (const r of runs) {
              const outcome = await one(r);
              outcomes.push(outcome);
              if (outcome?.cancelled || (outcome && outcome.code !== 0)) break;
            }
          }
          if (outcomes.some((o) => o?.cancelled)) return "cancelled";
          const failed = outcomes.find((o) => o && o.code !== 0);
          if (failed) {
            this.prompter.error(`${command.title} failed (exit ${failed.code ?? "?"}): ${failed.errorSummary}`, () =>
              this.processes.showOutput(),
            );
            return "failed";
          }
          this.prompter.info(`${command.title}: done`);
          return "ok";
        });
    }
  }

  private async runBatch(
    context: string,
    run: Extract<RenderedRun, { type: "batch" }>,
    targets: readonly KubeResource[],
    title: string,
  ): Promise<ExecutionResult> {
    if (run.operation === "copyNames") {
      try {
        await this.invoker.execute("k8sView.copyToClipboard", [targets.map((r) => r.name).join("\n")]);
        return "ok";
      } catch (e) {
        this.prompter.error(`${title} failed: ${errorMessage(e)}`);
        return "failed";
      }
    }
    return this.prompter.withProgress(`${title} (${targets.length} resources)`, async (token) => {
      try {
        const result = await this.batches.run(context, run, targets, token);
        if (result.failures.length) {
          this.prompter.error(
            `${title}: ${result.succeeded}/${targets.length} succeeded. ${result.failures.slice(0, MAX_LINES_SHOWN).join("; ")}${result.failures.length > MAX_LINES_SHOWN ? `; … and ${result.failures.length - MAX_LINES_SHOWN} more failures` : ""}`,
          );
          return "failed";
        }
        if (result.cancelled) return "cancelled";
        this.prompter.info(`${title}: ${result.succeeded}/${targets.length} succeeded`);
        return "ok";
      } catch (e) {
        this.prompter.error(`${title} failed: ${errorMessage(e)}`);
        return "failed";
      }
    });
  }

  private processSpec(title: string, run: Extract<RenderedRun, { type: "process" | "terminal" }>): ProcessSpec {
    const delimiter = this.workspace.platform() === "win32" ? ";" : ":";
    const path = [...this.settings.extraPath(), this.workspace.basePath()].filter(Boolean).join(delimiter);
    return {
      title,
      command: run.command,
      args: run.args,
      // Do not default cwd to the workspace directory: on Windows, binaries in cwd take precedence over PATH.
      cwd: run.cwd || undefined,
      env: { KUBECONFIG: this.contexts.kubeconfigEnv(), PATH: path, ...run.env },
    };
  }

  private async askInputs(
    command: CommandDefinition,
    first: KubeResource | undefined,
    vars: CommandVariables,
    cluster: ClusterContext,
  ): Promise<Record<string, string> | undefined> {
    const values: Record<string, string> = {};
    const history = this.state.getGlobal<Record<string, string>>(HISTORY_KEY) ?? {};
    const remembered: Record<string, string> = {};
    for (const input of command.inputs) {
      const cfg = input.config;
      const ctx = commandContext(first, { ...vars, inputs: values });
      const historyKey = `${command.id}/${cfg.id}`;
      let value: string | undefined;
      if (cfg.type === "pick") {
        let source: string[];
        if (cfg.fromKind) {
          try {
            source = await this.source.listNames(cluster, cfg.fromKind, first?.namespace ?? vars.namespace);
          } catch (e) {
            this.prompter.error(`${command.title}: cannot list ${cfg.fromKind.kind}: ${errorMessage(e)}`);
            return undefined;
          }
        } else {
          source = input.from ? input.from.all(first?.object ?? {}).map((v) => stringify(v)) : (cfg.options ?? []);
        }
        const options = [...new Set(source)].filter(Boolean);
        if (options.length === 0) {
          this.prompter.error(`${command.title}: no options for '${cfg.title}'.`);
          return undefined;
        }
        // Put the previous selection (or `default`) first in the list.
        const preferred = history[historyKey] ?? cfg.default;
        const ordered =
          preferred && options.includes(preferred) ? [preferred, ...options.filter((o) => o !== preferred)] : options;
        value = ordered.length === 1 ? ordered[0] : await this.prompter.pick(cfg.title, ordered);
        if (value !== undefined) remembered[historyKey] = value;
      } else if (cfg.type === "prompt") {
        const pattern = cfg.pattern ? new RegExp(cfg.pattern) : undefined;
        const initial = input.default?.render(ctx) || (cfg.secret ? undefined : history[historyKey]);
        value = await this.prompter.input({
          title: cfg.title,
          ...(initial ? { value: initial } : {}),
          ...(cfg.placeholder ? { placeholder: cfg.placeholder } : {}),
          ...(cfg.secret ? { password: true } : {}),
          validate: (v) => (pattern && !pattern.test(v) ? `Must match ${cfg.pattern}` : undefined),
        });
        if (value !== undefined && !cfg.secret) remembered[historyKey] = value;
      } else {
        const title = command.inputs.find((i) => i.config.id === cfg.id)?.config.title ?? cfg.title;
        value = (await this.prompter.confirm(title, "", "Continue")) ? "yes" : undefined;
      }
      if (value === undefined) return undefined;
      values[cfg.id] = value;
    }
    if (Object.keys(remembered).length > 0) await this.state.setGlobal(HISTORY_KEY, { ...history, ...remembered });
    return values;
  }

  private async approved(command: CommandDefinition): Promise<boolean> {
    const approved = this.state.getGlobal<Record<string, string>>(APPROVED_KEY) ?? {};
    if (approved[command.id] === command.hash) return true;
    const detail = JSON.stringify(command.config, null, 2);
    const origin = command.origin === "remote" ? "remote" : "workspace";
    if (!(await this.prompter.approveCommand(command.title, origin, detail))) return false;
    await this.state.setGlobal(APPROVED_KEY, { ...approved, [command.id]: command.hash });
    return true;
  }
}

/**
 * kubectl commands always receive an explicit `--context`, since the selected context may differ from current-context.
 * Only inspect/insert before `--` (the rest is the command executed in the container).
 */
function withContext(run: RenderedRun, context: string): RenderedRun {
  if (run.type !== "kubectl") return run;
  const sep = run.args.indexOf("--");
  const flags = sep < 0 ? run.args : run.args.slice(0, sep);
  if (flags.some((a) => a === "--context" || a.startsWith("--context="))) return run;
  const rest = sep < 0 ? [] : run.args.slice(sep);
  return { ...run, args: [...flags, "--context", context, ...rest] };
}

function timestamp(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}
