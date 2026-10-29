import { inject, injectable } from "@needle-di/core";
import { z } from "zod";
import { type DagLayout, type DagStageInput, layoutDag } from "../core/dag/layout";
import type { Job, Pipeline } from "../core/gitlab/model";
import { groupByStage } from "../core/gitlab/stages";
import { errorMessage } from "../core/util/errors";
import { GitLabApi } from "./ports/GitLabApi";
import type { RepoRef } from "./RepoRegistry";

const DAG_QUERY = `query GitLabCiViewDag($path: ID!, $iid: ID!) {
  project(fullPath: $path) {
    pipeline(iid: $iid) {
      stages { nodes { name groups { nodes { name jobs { nodes { id name status allowFailure needs { nodes { name } } } } } } } }
    }
  }
}`;

const dagSchema = z.object({
  project: z
    .object({
      pipeline: z
        .object({
          stages: z.object({
            nodes: z.array(
              z.object({
                name: z.string(),
                groups: z.object({
                  nodes: z.array(
                    z.object({
                      name: z.string(),
                      jobs: z.object({
                        nodes: z.array(
                          z.object({
                            id: z.string(),
                            name: z.string(),
                            status: z.string(),
                            allowFailure: z.boolean().nullish(),
                            needs: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
                          }),
                        ),
                      }),
                    }),
                  ),
                }),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export interface DagResult {
  readonly layout: DagLayout;
  /** `true`: GraphQL is unavailable; only stage columns, without `needs` edges. */
  readonly fallback: boolean;
  readonly error?: string;
}

export function gidToNumber(gid: string): number | undefined {
  const m = /\/(\d+)$/.exec(gid);
  return m ? Number(m[1]) : undefined;
}

@injectable()
export class DagService {
  constructor(private readonly api = inject(GitLabApi)) {}

  async load(repo: RepoRef, pipeline: Pipeline, jobs: readonly Job[]): Promise<DagResult> {
    try {
      const data = await this.api.graphql(
        repo,
        DAG_QUERY,
        { path: repo.projectPath, iid: String(pipeline.iid) },
        dagSchema,
      );
      const stages = data.project?.pipeline?.stages.nodes;
      if (!stages) throw new Error("GraphQL did not return this pipeline.");
      const input: DagStageInput[] = stages.map((s) => ({
        name: s.name,
        jobs: s.groups.nodes.flatMap((g) =>
          g.jobs.nodes.map((j) => ({
            id: gidToNumber(j.id),
            name: j.name,
            group: g.name,
            status: j.status.toLowerCase(),
            allowFailure: j.allowFailure ?? false,
            needs: j.needs?.nodes.map((n) => n.name) ?? [],
          })),
        ),
      }));
      return { layout: layoutDag(input), fallback: false };
    } catch (e) {
      const input: DagStageInput[] = groupByStage(jobs).map((g) => ({
        name: g.stage,
        jobs: g.jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          allowFailure: j.allowFailure,
          needs: [],
        })),
      }));
      return { layout: layoutDag(input), fallback: true, error: errorMessage(e) };
    }
  }
}
