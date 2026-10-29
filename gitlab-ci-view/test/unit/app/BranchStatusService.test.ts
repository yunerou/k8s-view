import { beforeEach, describe, expect, test } from "vitest";
import { BranchStatusService } from "../../../src/app/BranchStatusService";
import { PipelineService } from "../../../src/app/PipelineService";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { TokenStore } from "../../../src/app/TokenStore";
import { finishedOutcome, shouldNotify } from "../../../src/core/notify/transitions";
import { FakeNotifier, FakeRepoSource, FakeSecrets, FakeSettings, FakeState, gitRepo } from "../helpers/fakes";
import { FakeGitLabApi, rawPipeline } from "../helpers/gitlab";

const P = "/projects/team%2Fweb";
let latest: Record<string, unknown> | undefined;
let api: FakeGitLabApi;
let source: FakeRepoSource;
let settings: FakeSettings;
let notifier: FakeNotifier;
let service: BranchStatusService;

beforeEach(async () => {
  latest = rawPipeline({ id: 5, status: "success" });
  api = new FakeGitLabApi().route(`GET ${P}/pipelines`, () => (latest ? [latest] : []));
  source = new FakeRepoSource();
  source.list = [gitRepo("web", "git@gitlab.com:team/web.git")];
  settings = new FakeSettings();
  const tokens = new TokenStore(new FakeSecrets(), new FakeState());
  await tokens.save("gitlab.com", "t", { expiresAt: null, scopes: ["api"], expirySource: "api", verifiedAt: "x" });
  notifier = new FakeNotifier();
  service = new BranchStatusService(
    new RepoRegistry(source, settings, tokens),
    tokens,
    new PipelineService(api),
    settings,
    notifier,
  );
});

describe("transitions", () => {
  test("only a pipeline that was running and is now finished counts", () => {
    const p = (id: number, status: string) => ({ id, status });
    expect(finishedOutcome(p(1, "running"), p(1, "failed"))).toBe("failed");
    expect(finishedOutcome(p(1, "pending"), p(1, "success"))).toBe("succeeded");
    expect(finishedOutcome(p(1, "running"), p(1, "canceled"))).toBe("canceled");
    expect(finishedOutcome(undefined, p(1, "failed"))).toBeUndefined();
    expect(finishedOutcome(p(1, "failed"), p(1, "failed"))).toBeUndefined();
    expect(finishedOutcome(p(1, "running"), p(2, "failed"))).toBeUndefined();
    expect([
      shouldNotify("failed", "failed"),
      shouldNotify("succeeded", "failed"),
      shouldNotify("succeeded", "all"),
    ]).toEqual([true, false, true]);
    expect(shouldNotify("failed", "off")).toBe(false);
  });
});

describe("BranchStatusService", () => {
  test("asks for the latest pipeline of the checked-out branch; the first load never notifies", async () => {
    expect(await service.refresh()).toBe(false);
    expect(api.calls[0]?.query).toMatchObject({ ref: "main", per_page: 1, page: 1 });
    expect(service.latestFor("file:///ws/web")?.id).toBe(5);
    expect(notifier.messages).toEqual([]);
  });

  test("notifies when a running pipeline fails and offers to open it", async () => {
    const opened: unknown[] = [];
    service.onOpenRequested((t) => opened.push(t));
    latest = rawPipeline({ id: 6, status: "running" });
    expect(await service.refresh()).toBe(true);
    latest = rawPipeline({ id: 6, status: "failed" });
    notifier.reply = "Open";
    await service.refresh();
    expect(notifier.messages).toEqual([
      { level: "error", message: "web: pipeline #6 on main failed.", actions: ["Open"] },
    ]);
    await Promise.resolve();
    expect(opened).toEqual([{ repoId: "file:///ws/web", pipelineId: 6 }]);
  });

  test("success is only announced in 'all' mode", async () => {
    latest = rawPipeline({ id: 7, status: "running" });
    await service.refresh();
    latest = rawPipeline({ id: 7, status: "success" });
    await service.refresh();
    expect(notifier.messages).toEqual([]);
    settings.values.notifications = "all";
    latest = rawPipeline({ id: 8, status: "running" });
    await service.refresh();
    latest = rawPipeline({ id: 8, status: "success" });
    await service.refresh();
    expect(notifier.messages.map((m) => m.message)).toEqual(["web: pipeline #8 on main succeeded."]);
  });

  test("switching branch does not announce the other branch's pipeline", async () => {
    latest = rawPipeline({ id: 9, status: "running" });
    await service.refresh();
    source.set([gitRepo("web", "git@gitlab.com:team/web.git", "feature/x")]);
    latest = rawPipeline({ id: 9, status: "failed", ref: "feature/x" });
    await service.refresh();
    expect(notifier.messages).toEqual([]);
  });
});

test("a response arriving after checkout does not repopulate the old branch", async () => {
  let release: (value: unknown) => void = () => undefined;
  api.route(
    `GET ${P}/pipelines`,
    new Promise((r) => {
      release = r;
    }),
  );
  const old = service.refresh();
  source.set([gitRepo("web", "git@gitlab.com:team/web.git", "feature/x")]);
  release([rawPipeline({ id: 9, status: "failed" })]);
  await old;
  expect(service.latestFor("file:///ws/web")).toBeUndefined();
  expect(notifier.messages).toEqual([]);
});
