import { beforeEach, describe, expect, test } from "vitest";
import { effectiveFilters } from "../../../src/app/filters";
import { RepoRegistry } from "../../../src/app/RepoRegistry";
import { ALL, RepoSelection } from "../../../src/app/RepoSelection";
import { TokenStore } from "../../../src/app/TokenStore";
import { FakeRepoSource, FakeSecrets, FakeSettings, FakeState, gitRepo } from "../helpers/fakes";

let source: FakeRepoSource;
let settings: FakeSettings;
let state: FakeState;
let tokens: TokenStore;
let registry: RepoRegistry;
let events: number;

beforeEach(() => {
  source = new FakeRepoSource();
  settings = new FakeSettings();
  state = new FakeState();
  tokens = new TokenStore(new FakeSecrets(), state);
  source.list = [
    gitRepo("web", "git@gitlab.com:team/web.git"),
    gitRepo("api", "https://git.company.vn/team/api.git", "develop"),
    gitRepo("docs", "git@github.com:team/docs.git"),
  ];
  registry = new RepoRegistry(source, settings, tokens);
  events = 0;
  registry.onDidChange(() => events++);
});

describe("RepoRegistry", () => {
  test("keeps only GitLab repositories, sorted by name", () => {
    expect(registry.repos()).toEqual([
      {
        id: "file:///ws/web",
        name: "web",
        branch: "main",
        host: "gitlab.com",
        apiUrl: "https://gitlab.com",
        projectPath: "team/web",
      },
    ]);
  });

  test("a self-hosted repo appears once its host is configured or has a token", async () => {
    settings.set({ hosts: [{ host: "git.company.vn" }] });
    expect(registry.repos().map((r) => r.name)).toEqual(["api", "web"]);
    settings.set({ hosts: [] });
    expect(registry.repos().map((r) => r.name)).toEqual(["web"]);
    await tokens.save("git.company.vn", "t", {
      expiresAt: null,
      scopes: ["api"],
      expirySource: "api",
      verifiedAt: "x",
    });
    expect(registry.repos().map((r) => r.name)).toEqual(["api", "web"]);
    expect(events).toBe(3);
  });

  test("does not fire when the git state changes without affecting the list", () => {
    source.set([...source.list]);
    expect(events).toBe(0);
    source.set([gitRepo("web", "git@gitlab.com:team/web.git", "feature/x"), ...source.list.slice(1)]);
    expect(events).toBe(1);
    expect(registry.get("file:///ws/web")?.branch).toBe("feature/x");
  });

  test("hostTargets suggests every remote host except well-known non-GitLab ones", () => {
    expect(registry.hostTargets()).toEqual([
      { host: "gitlab.com", apiUrl: "https://gitlab.com" },
      { host: "git.company.vn", apiUrl: "https://git.company.vn" },
    ]);
  });
});

describe("RepoSelection", () => {
  test("defaults to all and falls back to all when the selected repo disappears", async () => {
    const selection = new RepoSelection(registry, state, settings);
    expect(selection.selection).toBe(ALL);
    await selection.select("file:///ws/web");
    expect(selection.visibleRepos().map((r) => r.name)).toEqual(["web"]);
    source.set([]);
    expect(selection.selection).toBe(ALL);
    expect(selection.visibleRepos()).toEqual([]);
  });

  test("filters default from settings and are persisted per workspace", async () => {
    settings.values.refFilter = "all";
    const selection = new RepoSelection(registry, state, settings);
    let changed = 0;
    selection.onDidChange(() => changed++);
    expect(selection.filters).toEqual({ ref: "all", status: "", source: "", mine: false });
    await selection.setFilters({ ref: "current", status: "failed", source: "", mine: true });
    expect(selection.filters).toEqual({ ref: "current", status: "failed", source: "", mine: true });
    expect(changed).toBe(1);
  });
});

describe("effectiveFilters", () => {
  const web = {
    id: "w",
    name: "web",
    host: "gitlab.com",
    apiUrl: "https://gitlab.com",
    projectPath: "t/w",
    branch: "main",
  };
  test("maps the UI filters to API parameters", () => {
    expect(effectiveFilters(web, { ref: "current", status: "", source: "", mine: false }, "me")).toEqual({
      ref: "main",
    });
    expect(effectiveFilters(web, { ref: "all", status: "running", source: "schedule", mine: true }, "me")).toEqual({
      status: "running",
      source: "schedule",
      username: "me",
    });
    expect(
      effectiveFilters(
        { ...web, branch: undefined },
        { ref: "current", status: "", source: "", mine: true },
        undefined,
      ),
    ).toEqual({});
  });
});

test("tag scope does not accidentally constrain results to the checked-out branch", () => {
  expect(
    effectiveFilters(
      { id: "r", name: "r", host: "gitlab.com", apiUrl: "https://gitlab.com", projectPath: "g/p", branch: "main" },
      { ref: "tags", source: "", status: "", mine: false },
      undefined,
    ),
  ).toEqual({ scope: "tags" });
});

test("an explicit tag name takes precedence over the current branch", () => {
  expect(
    effectiveFilters(
      { id: "r", name: "r", host: "gitlab.com", apiUrl: "https://gitlab.com", projectPath: "g/p", branch: "main" },
      { ref: "current", refName: " v1.2.3 ", source: "push", status: "", mine: false },
      undefined,
    ),
  ).toEqual({ ref: "v1.2.3", source: "push" });
});
