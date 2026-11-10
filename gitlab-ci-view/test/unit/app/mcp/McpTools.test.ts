import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolName, toolCatalog } from "../../../../src/app/mcp/McpTools";
import { GitLabError, type GitLabErrorKind } from "../../../../src/app/ports/GitLabApi";
import { gitRepo } from "../../helpers/fakes";
import { rawJob, rawPipeline } from "../../helpers/gitlab";
import { context, dataResult, mcpFixture, P, textResult } from "../../helpers/mcp";

let f: ReturnType<typeof mcpFixture>;
beforeEach(() => {
  f = mcpFixture();
});
afterEach(() => f.dispose());
it("provides five read tools and returns camelCase metadata, pipelines, jobs and cleaned log", async () => {
  expect(Object.keys(toolCatalog)).toHaveLength(11);
  expect(dataResult(await f.tools.call("list_repos", {}, context))).toEqual([
    { name: "web", host: "gitlab.com", projectPath: "team/web", branch: "main", rootPath: "/ws/web", isDefault: true },
  ]);
  expect(dataResult(await f.tools.call("list_pipelines", {}, context))).toMatchObject([
    { id: 1, webUrl: expect.any(String) },
  ]);
  expect(f.api.calls[0]?.query).toMatchObject({ ref: "main", per_page: 10 });
  expect(dataResult(await f.tools.call("get_pipeline", {}, context))).toMatchObject({
    pipeline: { id: 1 },
    failedJobs: [{ id: 100, name: "build", stage: "build" }],
  });
  expect(dataResult(await f.tools.call("get_job", { jobId: 100 }, context))).toMatchObject({
    id: 100,
    allowFailure: false,
  });
  expect(dataResult(await f.tools.call("get_job_log", { jobId: 100, tail: 1 }, context))).toMatchObject({
    jobStatus: "success",
    text: "world",
    totalLines: 2,
  });
  expect(f.api.calls.at(-1)).toMatchObject({ method: "BYTES", path: `${P}/jobs/100/trace`, offset: 0 });
  expect(f.confirmer.confirm).not.toHaveBeenCalled();
});
it("applies explicit filters, handles detached HEAD, empty pipelines and ambiguous defaults", async () => {
  await f.tools.call("list_pipelines", { ref: "*", status: "failed", limit: 2 }, context);
  expect(f.api.calls[0]?.query).toEqual({ page: 1, per_page: 2, order_by: "id", sort: "desc", status: "failed" });
  f.source.set([gitRepo("web", "git@gitlab.com:team/web.git", undefined)].map((r) => ({ ...r, branch: undefined })));
  expect(textResult(await f.tools.call("list_pipelines", {}, context))).toContain("pass ref");
  expect(textResult(await f.tools.call("get_pipeline", {}, context))).toContain("pass pipelineId");
  expect(await f.tools.call("get_pipeline", { pipelineId: 1 }, context)).not.toHaveProperty("isError");
  f.source.set([gitRepo("web", "git@gitlab.com:team/web.git")]);
  f.api.route(`GET ${P}/pipelines`, []);
  expect(textResult(await f.tools.call("get_pipeline", {}, context))).toContain("No pipeline");
  f.source.set([gitRepo("web", "git@gitlab.com:team/web.git"), gitRepo("api", "git@gitlab.com:team/api.git")]);
  expect(dataResult(await f.tools.call("list_repos", {}, { isCancelled: () => false }))).toMatchObject([
    { isDefault: false },
    { isDefault: false },
  ]);
});

const actions: [ToolName, Record<string, unknown>, string, Record<string, unknown>][] = [
  ["retry_pipeline", { pipelineId: 1 }, `${P}/pipelines/1/retry`, rawPipeline({ id: 2 })],
  ["cancel_pipeline", { pipelineId: 1 }, `${P}/pipelines/1/cancel`, rawPipeline({ status: "canceled" })],
  ["retry_job", { jobId: 100 }, `${P}/jobs/100/retry`, rawJob({ id: 101 })],
  ["cancel_job", { jobId: 100 }, `${P}/jobs/100/cancel`, rawJob({ status: "canceled" })],
  ["play_job", { jobId: 100, variables: [{ key: " ENV ", value: "  sentinel=$x\n" }] }, `${P}/jobs/100/play`, rawJob()],
  [
    "run_pipeline",
    { ref: "feature/test", variables: [{ key: "ENV", value: "  sentinel=$x\n" }] },
    `${P}/pipeline`,
    rawPipeline({ id: 3 }),
  ],
];
describe.each(actions)("%s", (name, args, path, response) => {
  it("denies without writes or refresh", async () => {
    f.confirmer.confirm.mockResolvedValue(false);
    expect(await f.tools.call(name, args, context)).toMatchObject({
      isError: true,
      content: [{ text: "User declined in VS Code" }],
    });
    expect(f.api.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(f.now).not.toHaveBeenCalled();
  });
  it("confirms target metadata, posts once, returns the updated object and refreshes", async () => {
    f.api.route(`POST ${path}`, response);
    expect(dataResult(await f.tools.call(name, args, context))).toMatchObject({ id: response["id"] });
    expect(f.api.callsTo("POST", path)).toHaveLength(1);
    expect(f.now).toHaveBeenCalledOnce();
    expect(f.confirmer.confirm.mock.calls[0]?.join("\n")).toContain("gitlab.com/team/web");
    if (name.includes("job")) expect(f.confirmer.confirm.mock.calls[0]?.[1]).toContain("stage build");
    if (args["variables"]) {
      expect(f.confirmer.confirm.mock.calls[0]?.[1]).toContain("ENV=  sentinel=$x\n");
      expect(JSON.stringify(f.api.calls.at(-1)?.body)).toContain("sentinel");
    }
    expect(JSON.stringify(f.log.info.mock.calls)).not.toContain("sentinel");
  });
  it("does not write if cancelled while confirmation is pending", async () => {
    let cancelled = false;
    f.confirmer.confirm.mockImplementation(async () => {
      cancelled = true;
      return true;
    });
    expect(await f.tools.call(name, args, { ...context, isCancelled: () => cancelled })).toMatchObject({
      isError: true,
    });
    expect(f.api.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(f.now).not.toHaveBeenCalled();
    expect(f.log.info.mock.calls[0]?.[0]).toContain("cancelled");
  });
});
it("rejects invalid IDs, conflicting log modes and variables before confirming", async () => {
  await expect(f.tools.call("retry_job", { jobId: 0 }, context)).rejects.toThrow();
  for (const variables of [
    [
      { key: "A", value: "x" },
      { key: " A ", value: "y" },
    ],
    [{ key: "1BAD", value: "x" }],
  ]) {
    expect(await f.tools.call("run_pipeline", { ref: "main", variables }, context)).toMatchObject({ isError: true });
  }
  expect(await f.tools.call("get_job_log", { jobId: 100, tail: 1, grep: "[" }, context)).toMatchObject({
    isError: true,
  });
  expect(f.confirmer.confirm).not.toHaveBeenCalled();
});
it.each<GitLabErrorKind>([
  "noToken",
  "unauthorized",
  "forbidden",
  "notFound",
  "network",
  "tls",
  "timeout",
  "http",
  "invalidResponse",
])("maps %s errors without leaking API bodies or credentials", async (kind) => {
  f.api.route(`GET ${P}/jobs/100`, new GitLabError(kind, "token-sentinel body-value", "gitlab.com"));
  const result = await f.tools.call("get_job", { jobId: 100 }, context);
  expect(result).toMatchObject({ isError: true });
  expect(textResult(result)).toContain("gitlab.com");
  expect(JSON.stringify([result, f.log.info.mock.calls])).not.toContain("sentinel");
});
it("does not poll after metadata or write failures", async () => {
  f.api.route(`POST ${P}/jobs/100/retry`, new GitLabError("http", "sensitive", "gitlab.com"));
  expect(await f.tools.call("retry_job", { jobId: 100 }, context)).toMatchObject({ isError: true });
  f.api.route(`GET ${P}/jobs/100`, new Error("token-sentinel"));
  f.confirmer.confirm.mockClear();
  expect(await f.tools.call("retry_job", { jobId: 100 }, context)).toMatchObject({ isError: true });
  expect(f.confirmer.confirm).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
});
it("isolates simultaneous confirmations by cwd", async () => {
  f.source.set([gitRepo("web", "git@gitlab.com:team/web.git"), gitRepo("api", "git@gitlab.com:team/api.git")]);
  f.api
    .route("GET /projects/team%2Fapi/jobs/100", rawJob())
    .route("POST /projects/team%2Fapi/jobs/100/retry", rawJob());
  f.api.route(`POST ${P}/jobs/100/retry`, rawJob());
  const resolvers: ((value: boolean) => void)[] = [];
  f.confirmer.confirm.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
  const a = f.tools.call("retry_job", { jobId: 100 }, context);
  const b = f.tools.call("retry_job", { jobId: 100 }, { ...context, cwd: "/ws/api" });
  await vi.waitFor(() => expect(resolvers).toHaveLength(2));
  resolvers[1]!(true);
  resolvers[0]!(false);
  expect(await a).toHaveProperty("isError", true);
  expect(await b).not.toHaveProperty("isError");
  expect(f.api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    "/projects/team%2Fapi/jobs/100/retry",
  ]);
});
