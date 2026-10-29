import { beforeEach, describe, expect, test } from "vitest";
import { type TokenMeta, TokenStore } from "../../../src/app/TokenStore";
import { FakeSecrets, FakeState } from "../helpers/fakes";

const meta = (patch: Partial<TokenMeta> = {}): TokenMeta => ({
  expiresAt: "2026-12-01",
  scopes: ["api"],
  username: "me",
  expirySource: "api",
  verifiedAt: "2026-10-29T00:00:00.000Z",
  ...patch,
});

let secrets: FakeSecrets;
let store: TokenStore;
let changes: string[];

beforeEach(() => {
  secrets = new FakeSecrets();
  store = new TokenStore(secrets, new FakeState());
  changes = [];
  store.onDidChange((h) => changes.push(h));
});

describe("TokenStore", () => {
  test("saves the token in secrets and metadata in global state", async () => {
    await store.save("gitlab.com", "glpat-1", meta());
    await store.save("git.company.vn", "glpat-2", meta({ expiresAt: null }));
    expect(await store.token("gitlab.com")).toBe("glpat-1");
    expect(secrets.values.get("gitlabCiView.token/git.company.vn")).toBe("glpat-2");
    expect(store.hosts()).toEqual(["git.company.vn", "gitlab.com"]);
    expect(store.meta("git.company.vn")?.expiresAt).toBeNull();
    expect(changes).toEqual(["gitlab.com", "git.company.vn"]);
  });

  test("markInvalid flags the host once; saving a new token clears the flag", async () => {
    await store.save("gitlab.com", "old", meta());
    await store.markInvalid("gitlab.com");
    await store.markInvalid("gitlab.com");
    expect(store.meta("gitlab.com")?.invalid).toBe(true);
    expect(changes).toEqual(["gitlab.com", "gitlab.com"]);
    await store.save("gitlab.com", "new", meta());
    expect(store.meta("gitlab.com")?.invalid).toBeUndefined();
  });

  test("remove deletes token and metadata; unknown hosts are ignored", async () => {
    await store.save("gitlab.com", "t", meta());
    await store.updateMeta("other.host", { expiresAt: null });
    await store.remove("gitlab.com");
    expect(await store.token("gitlab.com")).toBeUndefined();
    expect(store.hosts()).toEqual([]);
  });
});
