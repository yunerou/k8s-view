import { beforeEach, describe, expect, test } from "vitest";
import { PAGE_SIZE, PipelineService } from "../../../src/app/PipelineService";
import { FakeGitLabApi, Paged, rawJob, rawPipeline, repoRef } from "../helpers/gitlab";

const P = "/projects/team%2Fweb";
let api: FakeGitLabApi;
let service: PipelineService;
const repo = repoRef();

beforeEach(() => {
  api = new FakeGitLabApi();
  service = new PipelineService(api);
});

describe("PipelineService", () => {
  test("listPipelines sends paging, ordering and filters", async () => {
    api.route(`GET ${P}/pipelines`, new Paged([rawPipeline({ id: 3 }), rawPipeline({ id: 2 })], 2));
    const page = await service.listPipelines(repo, 1, { ref: "main", status: "failed" });
    expect(page.items.map((p) => p.id)).toEqual([3, 2]);
    expect(page.nextPage).toBe(2);
    expect(api.calls[0]?.query).toEqual({
      page: 1,
      per_page: PAGE_SIZE,
      order_by: "id",
      sort: "desc",
      ref: "main",
      status: "failed",
    });
  });

  test("listJobs follows pages and sorts by id", async () => {
    api.route(`GET ${P}/pipelines/9/jobs`, (c: { query?: { page?: number } }) =>
      c.query?.page === 1
        ? new Paged([rawJob({ id: 5 }), rawJob({ id: 4 })], 2)
        : new Paged([rawJob({ id: 1 })], undefined),
    );
    expect((await service.listJobs(repo, 9)).map((j) => j.id)).toEqual([1, 4, 5]);
    expect(api.calls.map((c) => c.query?.["per_page"])).toEqual([100, 100]);
  });

  test("listJobs stops after 10 pages", async () => {
    api.route(
      `GET ${P}/pipelines/9/jobs`,
      (c: { query?: { page?: number } }) => new Paged([rawJob({ id: c.query?.page ?? 0 })], (c.query?.page ?? 0) + 1),
    );
    expect(await service.listJobs(repo, 9)).toHaveLength(10);
  });

  test("actions hit the right endpoints", async () => {
    api
      .route(`POST ${P}/pipelines/9/retry`, rawPipeline({ id: 9 }))
      .route(`POST ${P}/pipelines/9/cancel`, rawPipeline({ id: 9, status: "canceled" }))
      .route(`POST ${P}/jobs/5/retry`, rawJob({ id: 6 }))
      .route(`POST ${P}/jobs/5/cancel`, rawJob({ id: 5, status: "canceled" }))
      .route(`POST ${P}/jobs/5/play`, rawJob({ id: 5, status: "pending" }));
    await service.retryPipeline(repo, 9);
    await service.cancelPipeline(repo, 9);
    expect((await service.retryJob(repo, 5)).id).toBe(6);
    await service.cancelJob(repo, 5);
    await service.playJob(repo, 5);
    await service.playJob(repo, 5, [{ key: "ENV", value: "staging" }]);
    expect(api.callsTo("POST", `${P}/jobs/5/play`).map((c) => c.body)).toEqual([
      {},
      { job_variables_attributes: [{ key: "ENV", value: "staging" }] },
    ]);
  });

  test("createPipeline sends ref and env variables", async () => {
    api.route(`POST ${P}/pipeline`, rawPipeline({ id: 77, status: "created" }));
    const p = await service.createPipeline(repo, "feature/x", [{ key: "A", value: "1" }]);
    expect(p.id).toBe(77);
    expect(api.calls[0]?.body).toEqual({
      ref: "feature/x",
      variables: [{ key: "A", value: "1", variable_type: "env_var" }],
    });
  });

  test("listBranches returns names", async () => {
    api.route(`GET ${P}/repository/branches`, [{ name: "main" }, { name: "develop" }]);
    expect(await service.listBranches(repo)).toEqual(["main", "develop"]);
  });
});

test("queries tag scope, exact ref and trigger event on the server", async () => {
  api.route(`GET ${P}/pipelines`, []);
  await service.listPipelines(repo, 1, { scope: "tags", ref: "v1.2.3", source: "push" });
  expect(api.calls[0]?.query).toMatchObject({ scope: "tags", ref: "v1.2.3", source: "push", per_page: 20 });
});

test("fills tag/source metadata missing from list responses and reuses it on refresh", async () => {
  api.route(`GET ${P}/pipelines`, [rawPipeline({ id: 7, ref: "v1.2.3", tag: undefined, source: undefined })]);
  api.route(`GET ${P}/pipelines/7`, rawPipeline({ id: 7, ref: "v1.2.3", tag: true, source: "push" }));
  const result = await service.listPipelines(repo, 1, {});
  expect(result.items[0]).toMatchObject({ tag: true, source: "push", ref: "v1.2.3" });
  await service.listPipelines(repo, 1, {});
  expect(api.callsTo("GET", `${P}/pipelines/7`)).toHaveLength(1);
});

test("metadata errors keep the list usable and can be retried", async () => {
  api.route(`GET ${P}/pipelines`, [rawPipeline({ id: 7, tag: undefined })]);
  api.route(`GET ${P}/pipelines/7`, new Error("offline"));
  expect((await service.listPipelines(repo, 1, {})).items[0]?.id).toBe(7);
  api.route(`GET ${P}/pipelines/7`, rawPipeline({ id: 7, tag: false }));
  expect((await service.listPipelines(repo, 1, {})).items[0]?.tag).toBe(false);
});
