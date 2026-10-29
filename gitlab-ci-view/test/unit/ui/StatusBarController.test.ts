import { beforeEach, describe, expect, test, vi } from "vitest";
import { BranchStatusService } from "../../../src/app/BranchStatusService";
import { PipelineService } from "../../../src/app/PipelineService";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { TokenStore } from "../../../src/app/TokenStore";
import { StatusBarController } from "../../../src/ui/StatusBarController";
import { FakeNotifier, FakeRepoSource, FakeSecrets, FakeSettings, FakeState, gitRepo } from "../helpers/fakes";
import { FakeGitLabApi, rawPipeline } from "../helpers/gitlab";

const { item, editor } = vi.hoisted(() => ({
  item: {
    name: "",
    text: "",
    tooltip: "",
    command: undefined as unknown,
    backgroundColor: undefined as unknown,
    shown: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    dispose() {},
  },
  editor: { uri: undefined as string | undefined },
}));

vi.mock("vscode", async (original) => {
  const actual = await original<typeof import("vscode")>();
  return {
    ...actual,
    window: {
      createStatusBarItem: () => item,
      get activeTextEditor() {
        return editor.uri ? { document: { uri: { toString: () => editor.uri } } } : undefined;
      },
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    },
  };
});

let source: FakeRepoSource;
let service: BranchStatusService;
let bar: StatusBarController;

beforeEach(async () => {
  item.shown = false;
  editor.uri = undefined;
  source = new FakeRepoSource();
  source.list = [gitRepo("web", "git@gitlab.com:team/web.git"), gitRepo("api", "git@gitlab.com:team/api.git")];
  const settings = new FakeSettings();
  const tokens = new TokenStore(new FakeSecrets(), new FakeState());
  await tokens.save("gitlab.com", "t", { expiresAt: null, scopes: ["api"], expirySource: "api", verifiedAt: "x" });
  const api = new FakeGitLabApi()
    .route("GET /projects/team%2Fweb/pipelines", [rawPipeline({ id: 1, status: "success" })])
    .route("GET /projects/team%2Fapi/pipelines", [rawPipeline({ id: 2, status: "failed" })]);
  const repos = new RepoRegistry(source, settings, tokens);
  service = new BranchStatusService(repos, tokens, new PipelineService(api), settings, new FakeNotifier());
  bar = new StatusBarController(service, repos);
  await service.refresh();
});

describe("StatusBarController", () => {
  test("shows the pipeline of the repository that holds the active file", () => {
    editor.uri = "file:///ws/api/src/main.ts";
    bar.start();
    expect(item.shown).toBe(true);
    expect(item.text).toBe("$(error) api: failed");
    expect(item.backgroundColor).toMatchObject({ id: "statusBarItem.errorBackground" });
    expect(item.command).toMatchObject({
      command: "gitlabCiView.openFullView",
      arguments: [{ repoId: "file:///ws/api", pipelineId: 2 }],
    });
  });

  test("with several repositories and no active file it stays hidden, then remembers the last repository", () => {
    bar.start();
    expect(item.shown).toBe(false);
    editor.uri = "file:///ws/web/README.md";
    bar.update();
    expect(item.text).toBe("$(pass) web: success");
    editor.uri = undefined;
    bar.update();
    expect(item.text).toBe("$(pass) web: success");
  });
});
