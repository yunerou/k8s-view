import { beforeEach, describe, expect, test } from "vitest";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { TokenFlow } from "../../../src/app/TokenFlow";
import { TokenService } from "../../../src/app/TokenService";
import { TokenStore } from "../../../src/app/TokenStore";
import { FakeNotifier, FakePrompter, FakeSecrets, FakeSettings, FakeState } from "../helpers/fakes";
import { FakeGitLabApi } from "../helpers/gitlab";

const gitlab = { host: "gitlab.com", apiUrl: "https://gitlab.com" };
let api: FakeGitLabApi;
let store: TokenStore;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let settings: FakeSettings;
let flow: TokenFlow;

beforeEach(() => {
  api = new FakeGitLabApi().route("GET /user", { username: "me" });
  store = new TokenStore(new FakeSecrets(), new FakeState());
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  settings = new FakeSettings();
  flow = new TokenFlow(
    new TokenService(api),
    store,
    settings,
    prompter,
    notifier,
    () => new Date("2026-10-29T00:00:00Z"),
  );
});

describe("TokenService.verify", () => {
  test("checks the new token, not the stored one", async () => {
    api.route("GET /personal_access_tokens/self", { scopes: ["api"], expires_at: "2026-12-01" });
    const r = await new TokenService(api).verify(gitlab, "glpat-new");
    expect(r).toEqual({ kind: "ok", expiresAt: "2026-12-01", scopes: ["api"], username: "me" });
    expect(api.calls.map((c) => c.token)).toEqual(["glpat-new", "glpat-new"]);
  });
});

describe("TokenFlow.setToken", () => {
  test("reads expiry and scopes from GitLab", async () => {
    api.route("GET /personal_access_tokens/self", { scopes: ["api", "read_user"], expires_at: "2026-12-01" });
    prompter.answers.push(gitlab, " glpat-abc ");
    expect(await flow.setToken([gitlab])).toBe(true);
    expect(await store.token("gitlab.com")).toBe("glpat-abc");
    expect(store.meta("gitlab.com")).toMatchObject({ expiresAt: "2026-12-01", expirySource: "api", username: "me" });
    expect(notifier.messages[0]?.message).toContain("expires in 33 days");
  });

  test("refuses a token without the api scope", async () => {
    api.route("GET /personal_access_tokens/self", { scopes: ["read_api"], expires_at: null });
    prompter.answers.push(gitlab, "glpat-ro");
    expect(await flow.setToken([gitlab])).toBe(false);
    expect(store.hosts()).toEqual([]);
    expect(notifier.messages[0]).toMatchObject({ level: "error" });
    expect(notifier.messages[0]?.message).toContain("read_api");
  });

  test("asks for the expiry date when GitLab cannot report it", async () => {
    api.route("GET /personal_access_tokens/self", new GitLabError("notFound", "404 Not Found", "gitlab.com", 404));
    prompter.answers.push(gitlab, "tok", "date", "2027-01-31");
    expect(await flow.setToken([gitlab])).toBe(true);
    expect(store.meta("gitlab.com")).toMatchObject({ expiresAt: "2027-01-31", expirySource: "manual", scopes: [] });
    expect(notifier.messages.at(-1)?.message).toContain('"api" scope');
  });

  test("manual expiry can be 'never'", async () => {
    api.route("GET /personal_access_tokens/self", new GitLabError("unauthorized", "401", "gitlab.com", 401));
    prompter.answers.push(gitlab, "tok", "never");
    await flow.setToken([gitlab]);
    expect(store.meta("gitlab.com")?.expiresAt).toBeNull();
  });

  test("an invalid token is not saved", async () => {
    api.route("GET /user", new GitLabError("unauthorized", "401 Unauthorized", "gitlab.com", 401));
    prompter.answers.push(gitlab, "bad");
    expect(await flow.setToken([gitlab])).toBe(false);
    expect(store.hosts()).toEqual([]);
    expect(notifier.messages[0]?.message).toContain("401 Unauthorized");
  });

  test("'Other host…' uses gitlabCiView.hosts for the api url", async () => {
    settings.values.hosts = [{ host: "git.company.vn", apiUrl: "https://git.company.vn/gitlab" }];
    api.route("GET /personal_access_tokens/self", { scopes: ["api"], expires_at: null });
    prompter.answers.push(null, "Git.Company.VN", "tok");
    await flow.setToken([gitlab]);
    expect(store.hosts()).toEqual(["git.company.vn"]);
  });

  test("a preset host skips the host picker; cancelling stops the flow", async () => {
    prompter.answers.push(undefined);
    expect(await flow.setToken([], gitlab)).toBe(false);
    expect(prompter.shown.map((s) => s.kind)).toEqual(["input"]);
  });
});

describe("TokenFlow.manage", () => {
  beforeEach(async () => {
    await store.save("gitlab.com", "t", {
      expiresAt: "2026-11-02",
      scopes: ["api"],
      username: "me",
      expirySource: "api",
      verifiedAt: "x",
    });
  });

  test("lists hosts with their expiry", async () => {
    prompter.answers.push(undefined);
    await flow.manage([gitlab]);
    expect(prompter.shown[0]?.items?.[0]).toMatchObject({
      label: "gitlab.com",
      description: "expires in 4 days · @me",
    });
  });

  test("removes a token after confirmation", async () => {
    prompter.answers.push("gitlab.com", "remove");
    notifier.reply = "Remove";
    await flow.manage([gitlab]);
    expect(store.hosts()).toEqual([]);
  });

  test("changes the expiry date by hand", async () => {
    prompter.answers.push("gitlab.com", "expiry", "never");
    await flow.manage([gitlab]);
    expect(store.meta("gitlab.com")).toMatchObject({ expiresAt: null, expirySource: "manual" });
  });
});
