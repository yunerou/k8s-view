import { beforeEach, describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { PipelineService } from "../../../src/app/PipelineService";
import { Poller } from "../../../src/app/Poller";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { RepoSelection } from "../../../src/app/RepoSelection";
import { TokenStore } from "../../../src/app/TokenStore";
import { PipelineTreeProvider } from "../../../src/ui/tree/PipelineTreeProvider";
import type { TreeNode } from "../../../src/ui/tree/TreeNode";
import { FakeRepoSource, FakeSecrets, FakeSettings, FakeState, gitRepo } from "../helpers/fakes";
import { type FakeCall, FakeGitLabApi, Paged, rawJob, rawPipeline } from "../helpers/gitlab";

const WEB = "/projects/team%2Fweb";
const API = "/projects/team%2Fapi";
let source: FakeRepoSource;
let tokens: TokenStore;
let selection: RepoSelection;
let api: FakeGitLabApi;
let tree: PipelineTreeProvider;

/** Two pipeline pages for the web repository: page 1 = #4,#3; page 2 = #3 (duplicate due to a newly inserted pipeline),#2. */
function webPages(c: FakeCall) {
  return c.query?.["page"] === 1
    ? new Paged([rawPipeline({ id: 4, status: "running" }), rawPipeline({ id: 3, status: "failed" })], 2)
    : new Paged([rawPipeline({ id: 3, status: "failed" }), rawPipeline({ id: 2 })], undefined);
}

beforeEach(async () => {
  source = new FakeRepoSource();
  source.list = [
    gitRepo("web", "git@gitlab.com:team/web.git"),
    gitRepo("api", "git@gitlab.com:team/api.git", "develop"),
  ];
  const settings = new FakeSettings();
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
    .route(`GET ${WEB}/pipelines`, webPages)
    .route(`GET ${API}/pipelines`, [rawPipeline({ id: 50 })]);
  tree = new PipelineTreeProvider(repos, selection, new PipelineService(api), tokens, new Poller(settings), () =>
    Date.parse("2026-10-29T10:10:00Z"),
  );
});

const labels = (nodes: TreeNode[]) =>
  nodes.map((n) => {
    const label = tree.getTreeItem(n).label;
    return typeof label === "string" ? label : label?.label;
  });
const item = (n: TreeNode) => tree.getTreeItem(n) as vscode.TreeItem;

describe("PipelineTreeProvider", () => {
  test("one selected repo shows its pipelines at the root, filtered by the current branch", async () => {
    await selection.select("file:///ws/web");
    const root = await tree.getChildren();
    expect(labels(root)).toEqual(["#4 main", "#3 main", "Load more…"]);
    expect(api.calls[0]?.query).toMatchObject({ page: 1, per_page: 20, ref: "main" });
    expect(item(root[0]!).description).toBe("running · Push · Branch · 10m ago");
    expect(item(root[1]!).contextValue).toBe("pipeline:retry");
    expect(item(root[0]!).contextValue).toBe("pipeline:cancel");
  });

  test("'all' groups by repository and each repo pages on its own", async () => {
    const root = await tree.getChildren();
    expect(labels(root)).toEqual(["api", "web"]);
    expect(labels(await tree.getChildren(root[0]))).toEqual(["#50 main"]);
    expect(api.callsTo("GET", `${API}/pipelines`)[0]?.query).toMatchObject({ ref: "develop" });
    const web = await tree.getChildren(root[1]);
    const more = web.at(-1)!;
    expect(more.type).toBe("loadMore");
    await tree.loadMore(more.type === "loadMore" ? more.repo : (undefined as never));
    expect(labels(await tree.getChildren(root[1]))).toEqual(["#4 main", "#3 main", "#2 main"]);
  });

  test("a rejected token shows a node that runs Set token instead of calling GitLab", async () => {
    await tokens.remove("gitlab.com");
    source.set([gitRepo("web", "git@gitlab.com:team/web.git")]);
    await tokens.save("gitlab.com", "t", {
      expiresAt: null,
      scopes: [],
      expirySource: "manual",
      verifiedAt: "x",
      invalid: true,
    });
    const [node] = await tree.getChildren();
    expect(item(node!).label).toBe("Token for gitlab.com was rejected. Click to update it.");
    expect(item(node!).command).toMatchObject({ command: "gitlabCiView.setToken", arguments: ["gitlab.com"] });
    expect(api.calls).toHaveLength(0);
  });

  test("pipelines expand into stages and jobs with the allowed actions", async () => {
    await selection.select("file:///ws/web");
    api.route(`GET ${WEB}/pipelines/4/jobs`, [
      rawJob({ id: 12, name: "deploy", stage: "deploy", status: "manual" }),
      rawJob({ id: 10, name: "build", stage: "build" }),
      rawJob({ id: 11, name: "lint", stage: "test", status: "failed", allow_failure: true }),
    ]);
    const [p4] = await tree.getChildren();
    const stages = await tree.getChildren(p4);
    expect(labels(stages)).toEqual(["build", "test", "deploy"]);
    const [deploy] = await tree.getChildren(stages[2]);
    expect(item(deploy!).contextValue).toBe("job:play");
    const [lint] = await tree.getChildren(stages[1]);
    expect((item(lint!).iconPath as vscode.ThemeIcon).id).toBe("warning");
  });

  test("refresh reloads loaded pages and expanded pipelines and reports activity", async () => {
    await selection.select("file:///ws/web");
    api.route(`GET ${WEB}/pipelines/4/jobs`, [rawJob({ id: 10, status: "running" })]);
    const root = await tree.getChildren();
    await tree.loadMore((root.at(-1) as Extract<TreeNode, { type: "loadMore" }>).repo);
    await tree.getChildren(root[0]);
    api.calls.length = 0;
    expect(await tree.refresh()).toBe(true);
    expect(api.calls.map((c) => [c.path, c.query?.["page"]])).toEqual([
      [`${WEB}/pipelines`, 1],
      [`${WEB}/pipelines`, 2],
      [`${WEB}/pipelines/4/jobs`, 1],
    ]);
    tree.setExpanded(root[0]!, false);
    api.route(`GET ${WEB}/pipelines`, [rawPipeline({ id: 4 })]);
    api.calls.length = 0;
    expect(await tree.refresh()).toBe(false);
    expect(api.calls.map((c) => c.path)).toEqual([`${WEB}/pipelines`]);
  });

  test("an API error keeps the previous pipelines and shows the message", async () => {
    await selection.select("file:///ws/web");
    await tree.getChildren();
    api.route(`GET ${WEB}/pipelines`, new GitLabError("network", "connect ECONNREFUSED", "gitlab.com"));
    await tree.refresh();
    expect(labels(await tree.getChildren())).toEqual(["#4 main", "#3 main", "connect ECONNREFUSED", "Load more…"]);
  });

  test("changing the selection or filters reloads from page 1", async () => {
    await selection.select("file:///ws/web");
    await tree.getChildren();
    await selection.setFilters({ ref: "all", status: "", source: "", mine: true });
    api.calls.length = 0;
    await tree.getChildren();
    expect(api.calls[0]?.query).toMatchObject({ page: 1, username: "me" });
    expect(api.calls[0]?.query?.["ref"]).toBeUndefined();
  });
});
