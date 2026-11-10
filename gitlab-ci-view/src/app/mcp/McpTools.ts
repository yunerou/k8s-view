import { inject, injectable } from "@needle-di/core";
import { z } from "zod";
import type { CiVariable } from "../../core/gitlab/model";
import { LOGGER } from "../../di/tokens";
import { PipelineService, project } from "../PipelineService";
import { Poller } from "../Poller";
import { Confirmer } from "../ports/Confirmer";
import { GitLabApi, GitLabError } from "../ports/GitLabApi";
import { type RepoRef, RepoRegistry } from "../RepoRegistry";
import { validateVariable } from "../RunPipelineFlow";
import { cleanLog, sliceLog, validateLogMode } from "./logText";
import { resolveRepo, rootPath } from "./repoResolver";

const repo = z.string().min(1).optional();
const id = z.number().int().positive().safe();
const ref = z.string().trim().min(1);
const variables = z.array(z.object({ key: z.string(), value: z.string() })).optional();
export const toolCatalog = {
  list_repos: {
    description: "List GitLab repositories and the default selected by the bridge working directory.",
    schema: z.object({}),
  },
  list_pipelines: {
    description: "List pipelines on the current branch; ref '*' selects all branches. Default limit 10, maximum 50.",
    schema: z.object({
      repo,
      ref: ref.optional(),
      status: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  },
  get_pipeline: {
    description:
      "Get a pipeline (default: latest on current branch), jobs and failed jobs. At most 1000 jobs per pipeline.",
    schema: z.object({ repo, pipelineId: id.optional() }),
  },
  get_job: { description: "Get job details.", schema: z.object({ repo, jobId: id }) },
  get_job_log: {
    description:
      "Read a cleaned job trace: tail (default 200), offset + limit (1-based), or JavaScript grep + context (max 20). Output capped at 2000 lines / 200 KiB / 50 matches. Downloads the full trace first; regex runs on that trace.",
    schema: z.object({
      repo,
      jobId: id,
      tail: id.optional(),
      offset: id.optional(),
      limit: id.optional(),
      grep: z.string().optional(),
      context: z.number().int().min(0).max(20).optional(),
    }),
  },
  retry_pipeline: {
    description: "Retry a pipeline after modal approval in VS Code.",
    schema: z.object({ repo, pipelineId: id }),
  },
  cancel_pipeline: {
    description: "Cancel a pipeline after modal approval in VS Code.",
    schema: z.object({ repo, pipelineId: id }),
  },
  retry_job: { description: "Retry a job after modal approval in VS Code.", schema: z.object({ repo, jobId: id }) },
  cancel_job: { description: "Cancel a job after modal approval in VS Code.", schema: z.object({ repo, jobId: id }) },
  play_job: {
    description: "Run a manual job after modal approval in VS Code, including any variables.",
    schema: z.object({ repo, jobId: id, variables }),
  },
  run_pipeline: {
    description: "Create a pipeline on an explicit ref after modal approval in VS Code, including any variables.",
    schema: z.object({ repo, ref, variables }),
  },
} as const;

export type ToolName = keyof typeof toolCatalog;
export const readTools = new Set<string>(["list_repos", "list_pipelines", "get_pipeline", "get_job", "get_job_log"]);
export interface McpContext {
  readonly cwd?: string;
  readonly isCancelled: () => boolean;
}
interface Args {
  repo?: string;
  pipelineId?: number;
  jobId?: number;
  ref?: string;
  status?: string;
  limit?: number;
  tail?: number;
  offset?: number;
  grep?: string;
  context?: number;
  variables?: CiVariable[];
}
class ToolError extends Error {}
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

@injectable()
export class McpTools {
  constructor(
    private readonly pipelines = inject(PipelineService),
    private readonly api = inject(GitLabApi),
    private readonly repos = inject(RepoRegistry),
    private readonly confirmer = inject(Confirmer),
    private readonly poller = inject(Poller),
    private readonly log: { info(message: string): void } = inject(LOGGER),
  ) {}

  async call(name: ToolName, input: unknown, context: McpContext) {
    // The HTTP SDK validates these schemas too. Keep validation outside domain error mapping.
    const args = toolCatalog[name].schema.parse(input) as Args;
    let target: RepoRef | undefined;
    let outcome = "error";
    try {
      this.checkCancelled(context);
      if (name === "list_repos") {
        let defaultId: string | undefined;
        try {
          defaultId = resolveRepo(this.repos.repos(), context).id;
        } catch {
          /* Ambiguity is useful metadata. */
        }
        const result = this.repos.repos().map((r) => ({
          name: r.name,
          projectPath: r.projectPath,
          host: r.host,
          branch: r.branch,
          rootPath: rootPath(r),
          isDefault: r.id === defaultId,
        }));
        outcome = "ok";
        return json(result);
      }
      try {
        target = resolveRepo(this.repos.repos(), {
          ...context,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
        });
      } catch (error) {
        throw new ToolError((error as Error).message);
      }
      const r = target;
      let result: unknown;
      if (name === "list_pipelines") {
        const branch = args.ref ?? r.branch;
        if (!branch) throw new ToolError("No current branch; pass ref explicitly (or '*' for all branches).");
        result = (
          await this.pipelines.listPipelines(
            r,
            1,
            { ...(branch !== "*" ? { ref: branch } : {}), ...(args.status ? { status: args.status } : {}) },
            args.limit ?? 10,
          )
        ).items;
      } else if (name === "get_pipeline") {
        let pipelineId = args.pipelineId;
        if (pipelineId === undefined) {
          if (!r.branch) throw new ToolError("No current branch; pass pipelineId explicitly.");
          pipelineId = (await this.pipelines.listPipelines(r, 1, { ref: r.branch }, 1)).items[0]?.id;
          if (pipelineId === undefined)
            throw new ToolError("No pipeline found on the current branch; pass pipelineId explicitly.");
        }
        const pipeline = await this.pipelines.getPipeline(r, pipelineId);
        const jobs = await this.pipelines.listJobs(r, pipelineId);
        result = {
          pipeline,
          jobs: jobs.map(({ id, name, stage, status, allowFailure, duration }) => ({
            id,
            name,
            stage,
            status,
            allowFailure,
            duration,
          })),
          failedJobs: jobs.filter((j) => j.status === "failed").map(({ id, name, stage }) => ({ id, name, stage })),
        };
      } else if (name === "get_job") {
        result = await this.pipelines.getJob(r, args.jobId!);
      } else if (name === "get_job_log") {
        const mode = {
          ...(args.tail !== undefined ? { tail: args.tail } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.grep !== undefined ? { grep: args.grep } : {}),
          ...(args.context !== undefined ? { context: args.context } : {}),
        };
        try {
          validateLogMode(mode);
          if (args.grep !== undefined) new RegExp(args.grep);
        } catch {
          throw new ToolError("Invalid log mode or grep pattern. Choose tail, offset + limit, or grep + context.");
        }
        const job = await this.pipelines.getJob(r, args.jobId!);
        const trace = await this.api.getBytes(r, `${project(r)}/jobs/${args.jobId}/trace`, 0);
        result = { jobStatus: job.status, ...sliceLog(cleanLog(new TextDecoder().decode(trace)), mode) };
      } else {
        const vars = this.variables(args.variables ?? []);
        let detail = `${r.host}/${r.projectPath}`;
        if (args.pipelineId !== undefined) {
          const pipeline = await this.pipelines.getPipeline(r, args.pipelineId);
          detail += `\nPipeline #${pipeline.id} (${pipeline.ref})`;
        } else if (args.jobId !== undefined) {
          const job = await this.pipelines.getJob(r, args.jobId);
          detail += `\nJob #${job.id}: ${job.name}, stage ${job.stage}`;
        } else {
          detail += `\nRef: ${args.ref}`;
        }
        if (vars.length) detail += `\nVariables:\n${vars.map((v) => `${v.key}=${v.value}`).join("\n")}`;
        this.checkCancelled(context);
        const allowed = await this.confirmer.confirm(
          `MCP client wants to ${name.replaceAll("_", " ")} in ${r.host}/${r.projectPath}.`,
          detail,
        );
        this.checkCancelled(context);
        if (!allowed) {
          outcome = "declined";
          return failure("User declined in VS Code");
        }
        switch (name) {
          case "retry_pipeline":
            result = await this.pipelines.retryPipeline(r, args.pipelineId!);
            break;
          case "cancel_pipeline":
            result = await this.pipelines.cancelPipeline(r, args.pipelineId!);
            break;
          case "retry_job":
            result = await this.pipelines.retryJob(r, args.jobId!);
            break;
          case "cancel_job":
            result = await this.pipelines.cancelJob(r, args.jobId!);
            break;
          case "play_job":
            result = await this.pipelines.playJob(r, args.jobId!, vars);
            break;
          case "run_pipeline":
            result = await this.pipelines.createPipeline(r, args.ref!, vars);
            break;
        }
        this.poller.now();
      }
      outcome = "ok";
      return json(result);
    } catch (error) {
      if (context.isCancelled()) {
        outcome = "cancelled";
        return failure("Request cancelled. If a GitLab action was already sent, check its status before retrying.");
      }
      if (error instanceof ToolError) return failure(error.message);
      if (error instanceof GitLabError) {
        const where = target ? `${target.host}/${target.projectPath}` : "GitLab";
        const messages = {
          noToken: `No GitLab token for ${target?.host ?? "host"}. Run 'GitLab CI: Set GitLab token' in VS Code.`,
          unauthorized: `GitLab token rejected for ${where}. Update it in VS Code.`,
          forbidden: `Permission denied for ${where}.`,
          notFound: `Project, pipeline or job not found in ${where}.`,
          network: `Cannot connect to ${where}. Check the network.`,
          timeout: `GitLab request timed out for ${where}. Check status before retrying actions.`,
          tls: `TLS verification failed for ${where}. Check host certificate settings.`,
          http: `GitLab HTTP error for ${where}. Check status and permissions in VS Code.`,
          invalidResponse: `Invalid GitLab response for ${where}.`,
        };
        return failure(messages[error.kind]);
      }
      return failure("MCP operation failed. Check GitLab CI View in VS Code.");
    } finally {
      // Never log raw arguments, exception messages, variables, results or traces.
      this.log.info(
        `MCP ${name} ${JSON.stringify({ repo: target ? `${target.host}/${target.projectPath}` : undefined, pipelineId: args.pipelineId, jobId: args.jobId, ref: args.ref })} ${outcome}`,
      );
    }
  }

  private checkCancelled(context: McpContext): void {
    if (context.isCancelled()) throw new ToolError("Request cancelled");
  }

  private variables(variables: readonly CiVariable[]): CiVariable[] {
    const keys = new Set<string>();
    return variables.map(({ key, value }) => {
      const normalized = key.trim();
      if (validateVariable(`${normalized}=${value}`))
        throw new ToolError(
          "Invalid variable name; use letters, digits and underscore, starting with a letter or underscore.",
        );
      if (keys.has(normalized)) throw new ToolError("Duplicate variable keys are not allowed.");
      keys.add(normalized);
      return { key: normalized, value };
    });
  }
}
