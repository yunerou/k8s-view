import { beforeEach, describe, expect, test } from "vitest";
import { DagService } from "../../../src/app/DagService";
import { FullViewModel } from "../../../src/app/FullViewModel";
import { PipelineService } from "../../../src/app/PipelineService";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { RepoSelection } from "../../../src/app/RepoSelection";
import { TokenStore } from "../../../src/app/TokenStore";
import { FakeRepoSource, FakeSecrets, FakeSettings, FakeState, gitRepo } from "../helpers/fakes";
import { type FakeCall, FakeGitLabApi, Paged, rawJob, rawPipeline } from "../helpers/gitlab";

const WEB = "/projects/team%2Fweb";
const WEB_ID = "file:///ws/web";
let api: FakeGitLabApi;
let tokens: TokenStore;
let selection: RepoSelection;
let model: FullViewModel;

beforeEach(async () => {
  const source = new FakeRepoSource();
  source.list = [gitRepo("web", "git@gitlab.com:team/web.git"), gitRepo("ops", "git@git.company.vn:team/ops.git")];
  const settings = new FakeSettings();
  settings.values.hosts = [{ host: "git.company.vn" }];
  const state = new FakeState();
  tokens = new TokenStore(new FakeSecrets(), state);
  await tokens.save("gitlab.com", "t", {
    expiresAt: null,
    scopes: ["api"],
    username: "me",
    expirySource: "api",
    verifiedAt: "x",
  });
  const repos = new RepoRegistry(source, settings, tokens);
  selection = new RepoSelection(repos, state, settings);
  api = new FakeGitLabApi()
    .route(
      `GET ${WEB}/pipelines`,
      (c: FakeCall) =>
        new Paged(
          [rawPipeline({ id: 100 + Number(c.query?.["page"]), status: "running" })],
          Number(c.query?.["page"]) + 1,
        ),
    )
    .route(`GET ${WEB}/pipelines/101`, rawPipeline({ id: 101, iid: 5, status: "running" }))
    .route(`GET ${WEB}/pipelines/101/jobs`, [
      rawJob({ id: 2, name: "unit", stage: "test", status: "running" }),
      rawJob({ id: 1 }),
    ]);
  const pipelines = new PipelineService(api);
  model = new FullViewModel(repos, selection, tokens, pipelines, new DagService(api), () => 1_000);
});

describe("FullViewModel", () => {
  test("one section per visible repo; repos without a token are not fetched", async () => {
    expect(await model.refresh()).toBe(true);
    const s = model.state();
    expect(s.repos.map((r) => [r.name, r.token])).toEqual([
      ["ops", "missing"],
      ["web", "ok"],
    ]);
    expect(s.sections.map((x) => [x.repoId, x.rows.map((r) => r.id), x.hasNext])).toEqual([
      ["file:///ws/ops", [], false],
      [WEB_ID, [101], true],
    ]);
    expect(s.sections[1]?.rows[0]?.actions).toEqual(["cancel"]);
    expect(api.calls.every((c) => c.path.startsWith(WEB))).toBe(true);
    expect(api.calls[0]?.query).toMatchObject({ ref: "main", per_page: 20 });
    expect(s.now).toBe(1_000);
  });

  test("pages are per repository", async () => {
    await model.refresh();
    await model.setPage(WEB_ID, 2);
    expect(model.state().sections[1]).toMatchObject({ page: 2, rows: [expect.objectContaining({ id: 102 })] });
  });

  test("a slow older page never replaces a newer one", async () => {
    let releaseOld: () => void = () => undefined;
    api.route(`GET ${WEB}/pipelines`, (c: FakeCall) =>
      c.query?.["page"] === 2
        ? new Promise((r) => {
            releaseOld = () => r(new Paged([rawPipeline({ id: 202 })], 3));
          })
        : new Paged([rawPipeline({ id: 303 })], undefined),
    );
    const older = model.setPage(WEB_ID, 2);
    await model.setPage(WEB_ID, 3);
    releaseOld();
    await older;
    expect(model.state().sections[1]).toMatchObject({ page: 3, rows: [expect.objectContaining({ id: 303 })] });
  });

  test("opening a pipeline loads it with its jobs grouped by stage", async () => {
    const states: unknown[] = [];
    model.onDidChange((s) => states.push(s.detail?.loading));
    await model.open(WEB_ID, 101);
    const d = model.state().detail!;
    expect(states[0]).toBe(true);
    expect(d.pipeline?.id).toBe(101);
    expect(d.stages.map((g) => [g.stage, g.jobs.map((j) => j.name)])).toEqual([
      ["build", ["build"]],
      ["test", ["unit"]],
    ]);
    expect(d.stages[1]?.jobs[0]?.actions).toEqual(["cancel"]);
    expect(model.job(WEB_ID, 2)?.name).toBe("unit");
    model.close();
    expect(model.state().detail).toBeUndefined();
  });

  test("the DAG tab loads the graph and refresh reloads it", async () => {
    api.route("GRAPHQL graphql", { project: { pipeline: { stages: { nodes: [] } } } });
    await model.open(WEB_ID, 101);
    await model.setTab("dag");
    expect(model.state().detail?.dag).toMatchObject({ fallback: false });
    expect(api.callsTo("GRAPHQL", "graphql")).toHaveLength(1);
    await model.refresh();
    expect(api.callsTo("GRAPHQL", "graphql")).toHaveLength(2);
  });

  test("a slow detail request for a closed pipeline is ignored", async () => {
    let release: () => void = () => undefined;
    api.route(
      `GET ${WEB}/pipelines/999`,
      new Promise((r) => {
        release = () => r(rawPipeline({ id: 999 }));
      }),
    );
    api.route(`GET ${WEB}/pipelines/999/jobs`, []);
    const slow = model.open(WEB_ID, 999);
    await model.open(WEB_ID, 101);
    release();
    await slow;
    expect(model.state().detail?.pipelineId).toBe(101);
    expect(model.state().detail?.pipeline?.id).toBe(101);
  });
});

test("a hidden model discards a pending page after filters change", async () => {
  let release: (value: unknown) => void = () => undefined;
  api.route(
    `GET ${WEB}/pipelines`,
    new Promise((r) => {
      release = r;
    }),
  );
  const old = model.setPage(WEB_ID, 2);
  await selection.setFilters({ ref: "all", status: "failed", source: "", mine: false });
  release(new Paged([rawPipeline({ id: 202 })], undefined));
  await old;
  expect(model.state().sections[1]).toMatchObject({ page: 1, rows: [] });
});
