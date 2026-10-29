import { beforeEach, describe, expect, test, vi } from "vitest";
import { PipelineService } from "../../../src/app/PipelineService";
import { Poller } from "../../../src/app/Poller";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { RepoSelection } from "../../../src/app/RepoSelection";
import { promptVariables, RunPipelineFlow, validateVariable } from "../../../src/app/RunPipelineFlow";
import { TokenStore } from "../../../src/app/TokenStore";
import {
  FakeNotifier,
  FakePrompter,
  FakeRepoSource,
  FakeSecrets,
  FakeSettings,
  FakeState,
  gitRepo,
} from "../helpers/fakes";
import { FakeGitLabApi, rawJob, rawPipeline, repoRef } from "../helpers/gitlab";

const P = "/projects/team%2Fweb";
let api: FakeGitLabApi;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let poller: Poller;
let source: FakeRepoSource;
let flow: RunPipelineFlow;

beforeEach(() => {
  api = new FakeGitLabApi()
    .route(`GET ${P}/repository/branches`, [{ name: "develop" }, { name: "main" }])
    .route(`POST ${P}/pipeline`, rawPipeline({ id: 77, status: "created" }));
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  const settings = new FakeSettings();
  const state = new FakeState();
  poller = new Poller(settings);
  // Prevent now() from scheduling real timers in tests.
  vi.spyOn(poller, "now").mockImplementation(() => undefined);
  source = new FakeRepoSource();
  source.list = [gitRepo("web", "git@gitlab.com:team/web.git")];
  const selection = new RepoSelection(
    new RepoRegistry(source, settings, new TokenStore(new FakeSecrets(), state)),
    state,
    settings,
  );
  flow = new RunPipelineFlow(new PipelineService(api), selection, prompter, notifier, poller);
});

describe("promptVariables", () => {
  test("adds, overrides and removes variables before confirming", async () => {
    prompter.answers.push(
      { kind: "add" },
      "A=1",
      { kind: "add" },
      "B=2",
      { kind: "add" },
      "A=3",
      { kind: "remove", index: 0 },
      { kind: "confirm" },
    );
    expect(await promptVariables(prompter, "t", "Run")).toEqual([{ key: "A", value: "3" }]);
  });

  test("cancel returns undefined", async () => {
    prompter.answers.push(undefined);
    expect(await promptVariables(prompter, "t", "Run")).toBeUndefined();
  });

  test.each([
    ["=x", "Use KEY=value"],
    ["A", "Use KEY=value"],
    ["1A=x", "Variable names use letters, digits and _ and cannot start with a digit"],
    ["A_1=", undefined],
    ["URL=a=b", undefined],
  ])("validateVariable(%j)", (raw, expected) => {
    expect(validateVariable(raw)).toBe(expected);
  });
});

describe("RunPipelineFlow.run", () => {
  test("offers the current branch first, then creates the pipeline", async () => {
    prompter.answers.push("develop", { kind: "confirm" });
    const p = await flow.run(repoRef());
    expect(p?.id).toBe(77);
    expect(prompter.shown[0]?.items?.map((i) => i.label)).toEqual([
      "$(git-branch) main",
      "$(git-branch) develop",
      "$(edit) Enter a branch or tag…",
    ]);
    expect(api.callsTo("POST", `${P}/pipeline`)[0]?.body).toEqual({ ref: "develop", variables: [] });
    expect(poller.now).toHaveBeenCalled();
    expect(notifier.messages[0]?.message).toBe("Pipeline #77 created on develop.");
  });

  test("a tag can be typed by hand, even when listing branches fails", async () => {
    api.route(`GET ${P}/repository/branches`, new GitLabError("forbidden", "403", "gitlab.com", 403));
    prompter.answers.push("", " v1.2.0 ", { kind: "confirm" });
    await flow.run(repoRef());
    expect(api.callsTo("POST", `${P}/pipeline`)[0]?.body).toMatchObject({ ref: "v1.2.0" });
  });

  test("without a repo argument it uses the only visible repository", async () => {
    prompter.answers.push("main", { kind: "confirm" });
    await flow.run();
    expect(prompter.shown[0]?.title).toBe("Run pipeline · web");
  });

  test("shows GitLab's error when the pipeline cannot be created", async () => {
    api.route(`POST ${P}/pipeline`, new GitLabError("http", "Reference not found", "gitlab.com", 400));
    prompter.answers.push("main", { kind: "confirm" });
    expect(await flow.run(repoRef())).toBeUndefined();
    expect(notifier.messages[0]).toMatchObject({ level: "error", message: "Cannot run pipeline: Reference not found" });
  });
});

describe("RunPipelineFlow.play", () => {
  test("runs a manual job with variables", async () => {
    api.route(`POST ${P}/jobs/5/play`, rawJob({ id: 5, status: "pending" }));
    prompter.answers.push({ kind: "add" }, "ENV=prod", { kind: "confirm" });
    await flow.play(repoRef(), { id: 5, name: "deploy" });
    expect(api.calls.at(-1)?.body).toEqual({ job_variables_attributes: [{ key: "ENV", value: "prod" }] });
    expect(prompter.shown[0]?.title).toBe("Run manual job · deploy");
  });
});
