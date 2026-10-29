import { beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import { DagService } from "../../../src/app/DagService";
import { FullViewModel } from "../../../src/app/FullViewModel";
import { PipelineService } from "../../../src/app/PipelineService";
import { Poller } from "../../../src/app/Poller";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { RepoSelection } from "../../../src/app/RepoSelection";
import { RunPipelineFlow } from "../../../src/app/RunPipelineFlow";
import { TokenStore } from "../../../src/app/TokenStore";
import { PipelinePanel } from "../../../src/ui/webview/PipelinePanel";
import {
  FakeNotifier,
  FakePrompter,
  FakeRepoSource,
  FakeSecrets,
  FakeSettings,
  FakeState,
  gitRepo,
} from "../helpers/fakes";
import { FakeGitLabApi, rawJob, rawPipeline } from "../helpers/gitlab";

const { handlers, notifications, panels, openExternal, executeCommand } = vi.hoisted(() => ({
  handlers: new Map<string, (params?: unknown) => unknown>(),
  notifications: [] as string[],
  panels: [] as { reveal: () => void; dispose: () => void; webview: { html: string }; visible: boolean }[],
  openExternal: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("vscode", async (original) => {
  const actual = await original<typeof import("vscode")>();
  return {
    ...actual,
    ViewColumn: { Active: -1 },
    env: { ...actual.env, openExternal },
    commands: { executeCommand },
    window: {
      createWebviewPanel: () => {
        const disposeHandlers: (() => void)[] = [];
        const panel = {
          title: "",
          visible: true,
          active: true,
          iconPath: undefined,
          webview: { html: "", options: {}, cspSource: "csp", asWebviewUri: (u: unknown) => u },
          onDidDispose: (h: () => void) => {
            disposeHandlers.push(h);
            return { dispose() {} };
          },
          onDidChangeViewState: () => ({ dispose() {} }),
          reveal: vi.fn(),
          dispose: () => {
            for (const h of disposeHandlers) h();
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
});

vi.mock("vscode-messenger", () => ({
  Messenger: class {
    registerWebviewPanel() {
      return {};
    }
    onRequest(type: { method: string }, handler: (params?: unknown) => unknown) {
      handlers.set(type.method, handler);
      return { dispose() {} };
    }
    sendNotification(type: { method: string }) {
      notifications.push(type.method);
    }
  },
}));

const WEB = "/projects/team%2Fweb";
const WEB_ID = "file:///ws/web";
let api: FakeGitLabApi;
let notifier: FakeNotifier;
let model: FullViewModel;
let panel: PipelinePanel;

async function call<T>(method: string, params?: unknown): Promise<T> {
  return (await handlers.get(`full/${method}`)!(params)) as T;
}

beforeEach(async () => {
  handlers.clear();
  notifications.length = 0;
  panels.length = 0;
  openExternal.mockClear();
  const source = new FakeRepoSource();
  source.list = [gitRepo("web", "git@gitlab.com:team/web.git")];
  const settings = new FakeSettings();
  const state = new FakeState();
  const tokens = new TokenStore(new FakeSecrets(), state);
  await tokens.save("gitlab.com", "t", { expiresAt: null, scopes: ["api"], expirySource: "api", verifiedAt: "x" });
  const repos = new RepoRegistry(source, settings, tokens);
  const selection = new RepoSelection(repos, state, settings);
  api = new FakeGitLabApi()
    .route(`GET ${WEB}/pipelines`, [rawPipeline({ id: 9, status: "failed" })])
    .route(`GET ${WEB}/pipelines/9`, rawPipeline({ id: 9, status: "failed" }))
    .route(`GET ${WEB}/pipelines/9/jobs`, [rawJob({ id: 1 })]);
  notifier = new FakeNotifier();
  const pipelines = new PipelineService(api);
  const poller = new Poller(settings);
  vi.spyOn(poller, "now").mockImplementation(() => undefined);
  model = new FullViewModel(repos, selection, tokens, pipelines, new DagService(api));
  const runFlow = new RunPipelineFlow(pipelines, selection, new FakePrompter(), notifier, poller);
  const context = { extensionUri: vscode.Uri.file("/ext"), subscriptions: [] } as unknown as vscode.ExtensionContext;
  panel = new PipelinePanel(context, model, repos, selection, pipelines, runFlow, poller, notifier);
});

describe("PipelinePanel", () => {
  test("opens one panel and reveals it on the next open", async () => {
    panel.open();
    panel.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.reveal).toHaveBeenCalledOnce();
    expect(panels[0]?.webview.html).toContain("pipeline.js");
    const state = await call<{ sections: { rows: { id: number }[] }[] }>("getState");
    expect(state.sections).toHaveLength(1);
  });

  test("open with a pipeline id shows its details", async () => {
    panel.open({ repoId: WEB_ID, pipelineId: 9 });
    await vi.waitFor(() => expect(model.state().detail?.pipeline?.id).toBe(9));
    expect(notifications).toContain("full/state");
  });

  test("actions call GitLab, refresh, and report errors", async () => {
    panel.open();
    api.route(`POST ${WEB}/pipelines/9/retry`, rawPipeline({ id: 9, status: "running" }));
    await call("action", { kind: "pipeline", repoId: WEB_ID, pipelineId: 9, action: "retry" });
    expect(api.callsTo("POST", `${WEB}/pipelines/9/retry`)).toHaveLength(1);
    api.route(`POST ${WEB}/jobs/1/cancel`, new GitLabError("forbidden", "403 Forbidden", "gitlab.com", 403));
    await call("action", { kind: "job", repoId: WEB_ID, jobId: 1, jobName: "build", action: "cancel" });
    expect(notifier.messages.at(-1)?.message).toContain("permission");
  });

  test("only http(s) links are opened", async () => {
    panel.open();
    await call("openUrl", { url: "javascript:alert(1)" });
    expect(openExternal).not.toHaveBeenCalled();
    await call("openUrl", { url: "https://gitlab.com/x" });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  test("closing the panel hides the model; opening again creates a new panel", () => {
    panel.open();
    expect(model.visible()).toBe(true);
    panels[0]?.dispose();
    expect(model.visible()).toBe(false);
    panel.open();
    expect(panels).toHaveLength(2);
  });
});
