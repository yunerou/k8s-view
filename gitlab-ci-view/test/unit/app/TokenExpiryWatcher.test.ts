import { beforeEach, describe, expect, test } from "vitest";
import { TokenExpiryWatcher } from "../../../src/app/TokenExpiryWatcher";
import { type TokenMeta, TokenStore } from "../../../src/app/TokenStore";
import { FakeNotifier, FakeSecrets, FakeSettings, FakeState } from "../helpers/fakes";

let now: Date;
let store: TokenStore;
let settings: FakeSettings;
let notifier: FakeNotifier;
let watcher: TokenExpiryWatcher;

const meta = (expiresAt: string | null, patch: Partial<TokenMeta> = {}): TokenMeta => ({
  expiresAt,
  scopes: ["api"],
  expirySource: "api",
  verifiedAt: "x",
  ...patch,
});

beforeEach(() => {
  now = new Date("2026-10-29T08:00:00Z");
  const state = new FakeState();
  store = new TokenStore(new FakeSecrets(), state);
  settings = new FakeSettings();
  notifier = new FakeNotifier();
  watcher = new TokenExpiryWatcher(store, state, settings, notifier, () => now);
});

describe("TokenExpiryWatcher", () => {
  test("warns once a day while the token is about to expire", async () => {
    await store.save("gitlab.com", "t", meta("2026-11-01"));
    await watcher.check();
    await watcher.check();
    expect(notifier.messages).toEqual([
      { level: "warn", message: "The GitLab token for gitlab.com expires in 3 days.", actions: ["Update token"] },
    ]);
    now = new Date("2026-10-30T08:00:00Z");
    await watcher.check();
    expect(notifier.messages.at(-1)?.message).toBe("The GitLab token for gitlab.com expires in 2 days.");
  });

  test("an expired token is an error; never-expiring, distant and rejected tokens are ignored", async () => {
    await store.save("old.host", "t", meta("2026-10-20"));
    await store.save("never.host", "t", meta(null));
    await store.save("far.host", "t", meta("2027-06-01"));
    await store.save("bad.host", "t", meta("2026-10-30", { invalid: true }));
    await watcher.check();
    expect(notifier.messages).toEqual([
      { level: "error", message: "The GitLab token for old.host has expired.", actions: ["Update token"] },
    ]);
  });

  test("respects tokenExpiryWarningDays", async () => {
    settings.values.warnDays = 2;
    await store.save("gitlab.com", "t", meta("2026-11-01"));
    await watcher.check();
    expect(notifier.messages).toEqual([]);
  });

  test("'Update token' asks to update that host", async () => {
    const hosts: string[] = [];
    watcher.onUpdateRequested((h) => hosts.push(h));
    notifier.reply = "Update token";
    await store.save("gitlab.com", "t", meta("2026-10-30"));
    await watcher.check();
    await Promise.resolve();
    expect(hosts).toEqual(["gitlab.com"]);
  });
});
