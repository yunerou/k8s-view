import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { jobSchema, pipelineSchema } from "../../src/core/gitlab/model";
import type { TestApi } from "../../src/extension";

/** Commands that must be registered; subsequent tasks add IDs here. */
const COMMANDS = [
  "gitlabCiView.runPipeline",
  "gitlabCiView.openFullView",
  "gitlabCiView.openLog",
  "gitlabCiView.selectRepository",
  "gitlabCiView.filter",
  "gitlabCiView.refresh",
  "gitlabCiView.setToken",
  "gitlabCiView.manageTokens",
  "gitlabCiView.loadMore",
  "gitlabCiView.retryPipeline",
  "gitlabCiView.cancelPipeline",
  "gitlabCiView.retryJob",
  "gitlabCiView.cancelJob",
  "gitlabCiView.playJob",
  "gitlabCiView.openInBrowser",
];

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("GitLab CI View", () => {
  let api: TestApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<TestApi>("yunerou.gitlab-ci-view");
    assert.ok(ext, "extension is installed");
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "test API is exposed (GITLAB_CI_VIEW_INTEGRATION=1)");
  });

  it("detects the GitLab repository from its remote and ignores GitHub", async () => {
    const repos = await waitFor("GitLab repo", () => api.repos.repos().length > 0 && api.repos.repos());
    assert.deepEqual(
      repos.map((r) => [r.name, r.host, r.projectPath, r.branch]),
      [["demo", "gitlab.com", "group/sub/demo", "main"]],
    );
  });

  it("asks for a token before calling GitLab", async () => {
    const [node] = await api.tree.getChildren();
    assert.ok(node);
    const item = api.tree.getTreeItem(node);
    assert.equal(item.label, "Set a GitLab token for gitlab.com");
    assert.deepEqual(item.command?.arguments, ["gitlab.com"]);
  });

  it("registers every command", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of COMMANDS) assert.ok(all.includes(id), id);
  });
});

describe("Tree with a stubbed GitLab client", () => {
  it("expands pipelines into stages and jobs without network access", async () => {
    const ext = vscode.extensions.getExtension<TestApi>("yunerou.gitlab-ci-view")!;
    const api = (await ext.activate()) as TestApi;
    const repo = api.repos.repos()[0]!;
    const originalList = api.pipelines.listPipelines;
    const originalJobs = api.pipelines.listJobs;
    api.pipelines.listPipelines = async () => ({
      items: [
        pipelineSchema.parse({
          id: 123,
          iid: 1,
          project_id: 7,
          status: "failed",
          ref: "main",
          sha: "abc123",
          web_url: "https://gitlab.com/group/sub/demo/-/pipelines/123",
          created_at: "2026-10-29T00:00:00Z",
        }),
      ],
      nextPage: undefined,
    });
    api.pipelines.listJobs = async () => [
      jobSchema.parse({
        id: 456,
        name: "unit",
        stage: "test",
        status: "failed",
        created_at: "2026-10-29T00:00:00Z",
        web_url: "https://gitlab.com/group/sub/demo/-/jobs/456",
      }),
    ];
    try {
      await api.tokens.save(repo.host, "integration-test-token", {
        expiresAt: null,
        scopes: ["api"],
        expirySource: "api",
        verifiedAt: new Date().toISOString(),
      });
      await api.selection.select(repo.id);
      const [pipeline] = await api.tree.getChildren();
      assert.equal(pipeline?.type, "pipeline");
      assert.equal(api.tree.getTreeItem(pipeline!).contextValue, "pipeline:retry");
      const [stage] = await api.tree.getChildren(pipeline);
      assert.equal(stage?.type, "stage");
      const [job] = await api.tree.getChildren(stage);
      assert.equal(job?.type, "job");
      assert.equal(api.tree.getTreeItem(job!).command?.command, "gitlabCiView.openLog");
    } finally {
      await api.tokens.remove(repo.host);
      api.pipelines.listPipelines = originalList;
      api.pipelines.listJobs = originalJobs;
    }
  });
});
