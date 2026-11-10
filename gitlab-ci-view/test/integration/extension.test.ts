import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { jobSchema, pipelineSchema } from "../../src/core/gitlab/model";
import type { TestApi } from "../../src/extension";

/** Commands that must be registered; subsequent tasks add IDs here. */
const COMMANDS = [
  "gitlabCiView.copyMcpSetupCommand",
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

describe("MCP lifecycle in the extension host", () => {
  it("publishes private discovery, serves eleven tools, toggles and updates workspace folders", async () => {
    const ext = vscode.extensions.getExtension<TestApi>("yunerou.gitlab-ci-view")!;
    const api = (await ext.activate()) as TestApi;
    const config = vscode.workspace.getConfiguration("gitlabCiView");
    const previous = config.inspect<boolean>("mcp.enabled")?.globalValue;
    const extra = await mkdtemp(join(tmpdir(), "gitlab-mcp-folder-"));
    let added = false;
    const read = async () =>
      JSON.parse(await readFile(api.mcp.discoveryPath, "utf8")) as {
        port: number;
        secret: string;
        workspaceFolders: string[];
      };
    try {
      assert.ok(api.mcp.discoveryPath.includes("mcp-integration"));
      await config.update("mcp.enabled", true, vscode.ConfigurationTarget.Global);
      await api.mcp.refresh();
      const first = await read();
      assert.deepEqual(
        first.workspaceFolders,
        vscode.workspace.workspaceFolders!.map((f) => f.uri.fsPath),
      );
      const response = await fetch(`http://127.0.0.1:${first.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${first.secret}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = (await response.json()) as { result: { tools: { name: string }[] } };
      assert.deepEqual(
        body.result.tools.map((t) => t.name).sort(),
        [
          "list_repos",
          "list_pipelines",
          "get_pipeline",
          "get_job",
          "get_job_log",
          "retry_pipeline",
          "cancel_pipeline",
          "retry_job",
          "cancel_job",
          "play_job",
          "run_pipeline",
        ].sort(),
      );
      if (process.platform !== "win32") assert.equal((await stat(api.mcp.discoveryPath)).mode & 0o777, 0o600);
      const event = new Promise<void>((resolve) => {
        const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
          sub.dispose();
          resolve();
        });
      });
      added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders!.length, 0, {
        uri: vscode.Uri.file(extra),
      });
      assert.ok(added);
      await event;
      await api.mcp.refresh();
      assert.ok((await read()).workspaceFolders.includes(extra));
      await config.update("mcp.enabled", false, vscode.ConfigurationTarget.Global);
      await api.mcp.refresh();
      await assert.rejects(stat(api.mcp.discoveryPath));
      await assert.rejects(fetch(`http://127.0.0.1:${first.port}/mcp`));
      await config.update("mcp.enabled", true, vscode.ConfigurationTarget.Global);
      await api.mcp.refresh();
      assert.notEqual((await read()).secret, first.secret);
    } finally {
      if (added) {
        const index = vscode.workspace.workspaceFolders!.findIndex((f) => f.uri.fsPath === extra);
        if (index >= 0) {
          const changed = new Promise<void>((resolve) => {
            const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
              sub.dispose();
              resolve();
            });
          });
          if (vscode.workspace.updateWorkspaceFolders(index, 1)) await changed;
        }
      }
      await config.update("mcp.enabled", previous, vscode.ConfigurationTarget.Global);
      await api.mcp.refresh();
      await rm(extra, { recursive: true, force: true });
    }
  });
});
