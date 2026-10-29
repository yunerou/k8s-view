import { inject, injectable } from "@needle-di/core";
import type { CiVariable, Pipeline } from "../core/gitlab/model";
import { errorMessage } from "../core/util/errors";
import { actionErrorMessage } from "./errors";
import { PipelineService } from "./PipelineService";
import { Poller } from "./Poller";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import type { RepoRef } from "./RepoRegistry";
import { RepoSelection } from "./RepoSelection";

type VariableChoice =
  | { readonly kind: "confirm" }
  | { readonly kind: "add" }
  | { readonly kind: "remove"; readonly index: number };

export function validateVariable(raw: string): string | undefined {
  const eq = raw.indexOf("=");
  if (eq <= 0) return "Use KEY=value";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.slice(0, eq).trim())
    ? undefined
    : "Variable names use letters, digits and _ and cannot start with a digit";
}

/** Quick Pick loop: add/remove variables until confirmed. `undefined` = canceled. */
export async function promptVariables(
  prompter: Prompter,
  title: string,
  confirmLabel: string,
): Promise<CiVariable[] | undefined> {
  const vars: CiVariable[] = [];
  for (;;) {
    const choice = await prompter.pick<VariableChoice>(
      [
        {
          label: `$(play) ${confirmLabel}`,
          description: vars.length > 0 ? `${vars.length} variable(s)` : "no variables",
          value: { kind: "confirm" },
        },
        { label: "$(add) Add variable…", value: { kind: "add" } },
        ...vars.map((v, index) => ({
          label: `$(trash) ${v.key}=${v.value}`,
          description: "remove",
          value: { kind: "remove", index } as const,
        })),
      ],
      { title },
    );
    if (!choice) return undefined;
    if (choice.kind === "confirm") return vars;
    if (choice.kind === "remove") {
      vars.splice(choice.index, 1);
      continue;
    }
    const raw = await prompter.input({
      title,
      prompt: "KEY=value",
      placeholder: "DEPLOY_ENV=staging",
      validate: validateVariable,
    });
    if (raw === undefined) continue;
    const eq = raw.indexOf("=");
    const key = raw.slice(0, eq).trim();
    const existing = vars.findIndex((v) => v.key === key);
    if (existing >= 0) vars.splice(existing, 1);
    vars.push({ key, value: raw.slice(eq + 1) });
  }
}

@injectable()
export class RunPipelineFlow {
  constructor(
    private readonly pipelines = inject(PipelineService),
    private readonly selection = inject(RepoSelection),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
    private readonly poller = inject(Poller),
  ) {}

  async run(repo?: RepoRef): Promise<Pipeline | undefined> {
    const target = repo ?? (await this.pickRepo());
    if (!target) return undefined;
    const ref = await this.pickRef(target);
    if (!ref) return undefined;
    const variables = await promptVariables(
      this.prompter,
      `Run pipeline · ${target.name} @ ${ref}`,
      `Run pipeline on ${ref}`,
    );
    if (!variables) return undefined;
    try {
      const pipeline = await this.pipelines.createPipeline(target, ref, variables);
      this.poller.now();
      void this.notifier.info(`Pipeline #${pipeline.id} created on ${ref}.`);
      return pipeline;
    } catch (e) {
      await this.notifier.error(`Cannot run pipeline: ${errorMessage(e)}`);
      return undefined;
    }
  }

  async play(repo: RepoRef, job: { readonly id: number; readonly name: string }): Promise<void> {
    const variables = await promptVariables(this.prompter, `Run manual job · ${job.name}`, `Run ${job.name}`);
    if (!variables) return;
    try {
      await this.pipelines.playJob(repo, job.id, variables);
      this.poller.now();
    } catch (e) {
      await this.notifier.error(`Cannot run ${job.name}: ${actionErrorMessage(e)}`);
    }
  }

  private async pickRepo(): Promise<RepoRef | undefined> {
    const repos = this.selection.visibleRepos();
    if (repos.length <= 1) return repos[0];
    return this.prompter.pick(
      repos.map((r) => ({ label: r.name, description: r.projectPath, value: r })),
      { title: "Run pipeline in…" },
    );
  }

  private async pickRef(repo: RepoRef): Promise<string | undefined> {
    let branches: string[] = [];
    try {
      branches = await this.pipelines.listBranches(repo);
    } catch {
      // Cannot list branches: still allow selecting the current branch or entering one manually.
    }
    const picked = await this.prompter.pick(
      [
        ...(repo.branch
          ? [{ label: `$(git-branch) ${repo.branch}`, description: "current branch", value: repo.branch }]
          : []),
        ...branches.filter((b) => b !== repo.branch).map((b) => ({ label: `$(git-branch) ${b}`, value: b })),
        { label: "$(edit) Enter a branch or tag…", value: "" },
      ],
      { title: `Run pipeline · ${repo.name}`, placeholder: "Branch or tag to run the pipeline on" },
    );
    if (picked === undefined) return undefined;
    if (picked !== "") return picked;
    const typed = await this.prompter.input({
      title: `Run pipeline · ${repo.name}`,
      prompt: "Branch or tag",
      validate: (v) => (v.trim() ? undefined : "Enter a branch or tag"),
    });
    return typed?.trim() || undefined;
  }
}
