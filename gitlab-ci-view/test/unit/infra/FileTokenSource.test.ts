import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TokenStore } from "../../../src/app/TokenStore";
import { FileTokenSource } from "../../../src/infra/state/FileTokenSource";
import { FakeSecrets, FakeSettings, FakeState } from "../helpers/fakes";

let directory: string;
let path: string;
let settings: FakeSettings;
let source: FileTokenSource;
let store: TokenStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gitlab-ci-token-"));
  path = join(directory, "token");
  settings = new FakeSettings();
  settings.values.hosts = [{ host: "gitlab.com", tokenFile: path }];
  source = new FileTokenSource(settings);
  store = new TokenStore(new FakeSecrets(), new FakeState(), source);
});

afterEach(async () => {
  store.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe("file tokens", () => {
  test("recognises a configured file without stored metadata and reads each updated token", async () => {
    expect(store.hosts()).toEqual(["gitlab.com"]);
    expect(store.meta("gitlab.com")).toMatchObject({ expirySource: "file" });
    await writeFile(path, " glpat-first\n");
    expect(await store.token("gitlab.com")).toBe("glpat-first");
    await store.markInvalid("gitlab.com");
    await writeFile(path, "glpat-rotated\n");
    expect(store.meta("gitlab.com")?.invalid).toBeUndefined();
    expect(await store.token("gitlab.com")).toBe("glpat-rotated");
  });

  test("file takes priority over SecretStorage, removing configuration restores the global token", async () => {
    await store.save("gitlab.com", "global-token", {
      expiresAt: "2026-12-01",
      scopes: ["api"],
      expirySource: "api",
      verifiedAt: "x",
    });
    await writeFile(path, "file-token");
    expect(await store.token("gitlab.com")).toBe("file-token");
    const changed: string[] = [];
    store.onDidChange((host) => changed.push(host));
    settings.set({ hosts: [{ host: "other.host", tokenFile: path }] });
    expect(changed).toEqual(["gitlab.com", "other.host"]);
    expect(await store.token("gitlab.com")).toBe("global-token");
    expect(store.meta("gitlab.com")?.expirySource).toBe("api");
  });

  test("missing, empty or multiline files fail clearly without falling back to another credential", async () => {
    await expect(store.token("gitlab.com")).rejects.toMatchObject({
      kind: "noToken",
      message: expect.stringContaining("Cannot read tokenFile"),
    });
    for (const content of [" \n", "secret-one\nsecret-two"]) {
      await writeFile(path, content);
      await expect(store.token("gitlab.com")).rejects.toMatchObject({
        kind: "noToken",
        message: expect.stringContaining("single non-empty token"),
      });
      try {
        await store.token("gitlab.com");
      } catch (error) {
        expect(String(error)).not.toContain("secret-one");
      }
    }
  });

  test("relative paths are rejected instead of depending on the workspace directory", async () => {
    settings.values.hosts = [{ host: "gitlab.com", tokenFile: "./token" }];
    await expect(source.read("gitlab.com")).rejects.toMatchObject({
      kind: "noToken",
      message: expect.stringContaining("absolute path"),
    });
  });
});
