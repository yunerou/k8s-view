import { describe, expect, test } from "vitest";
import { DagService, gidToNumber } from "../../../src/app/DagService";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { FakeGitLabApi, job, pipeline, repoRef } from "../helpers/gitlab";

const graph = {
  project: {
    pipeline: {
      stages: {
        nodes: [
          {
            name: "build",
            groups: {
              nodes: [
                {
                  name: "compile",
                  jobs: {
                    nodes: [
                      {
                        id: "gid://gitlab/Ci::Build/10",
                        name: "compile",
                        status: "SUCCESS",
                        allowFailure: false,
                        needs: { nodes: [] },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            name: "test",
            groups: {
              nodes: [
                {
                  name: "unit",
                  jobs: {
                    nodes: [
                      {
                        id: "gid://gitlab/Ci::Build/11",
                        name: "unit",
                        status: "WAITING_FOR_RESOURCE",
                        allowFailure: true,
                        needs: { nodes: [{ name: "compile" }] },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  },
};

describe("DagService", () => {
  test("uses GraphQL needs", async () => {
    const api = new FakeGitLabApi().route("GRAPHQL graphql", graph);
    const r = await new DagService(api).load(repoRef(), pipeline({ id: 9, iid: 3 }), []);
    expect(r.fallback).toBe(false);
    expect(api.calls[0]?.variables).toEqual({ path: "team/web", iid: "3" });
    expect(r.layout.nodes.map((n) => [n.jobId, n.status, n.allowFailure])).toEqual([
      [10, "success", false],
      [11, "waiting_for_resource", true],
    ]);
    expect(r.layout.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["compile->unit"]);
  });

  test("falls back to stage columns from REST jobs when GraphQL fails", async () => {
    const api = new FakeGitLabApi().route(
      "GRAPHQL graphql",
      new GitLabError("http", "Field 'needs' doesn't exist", "gitlab.com"),
    );
    const jobs = [job({ id: 2, name: "unit", stage: "test" }), job({ id: 1, name: "compile", stage: "build" })];
    const r = await new DagService(api).load(repoRef(), pipeline(), jobs);
    expect(r).toMatchObject({ fallback: true, error: "Field 'needs' doesn't exist" });
    expect(r.layout.columns.map((c) => c.stage)).toEqual(["build", "test"]);
    expect(r.layout.edges).toEqual([]);
  });

  test("a missing pipeline in GraphQL also falls back", async () => {
    const api = new FakeGitLabApi().route("GRAPHQL graphql", { project: { pipeline: null } });
    expect((await new DagService(api).load(repoRef(), pipeline(), [])).fallback).toBe(true);
  });

  test("gidToNumber", () => {
    expect(gidToNumber("gid://gitlab/Ci::Bridge/42")).toBe(42);
    expect(gidToNumber("weird")).toBeUndefined();
  });
});
