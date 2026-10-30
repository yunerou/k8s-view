import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { NodeRunner } from "../../../src/infra/process/NodeRunner";
import { FileSshConfigStore } from "../../../src/infra/ssh/FileSshConfigStore";
import { FakeSettings } from "../helpers/fakes";

let home: string;
let storage: string;
let store: FileSshConfigStore;
const userConfig = () => join(home, ".ssh", "config");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aws-view-ssh-"));
  storage = join(home, "storage dir");
  const settings = new FakeSettings();
  settings.values.sshConfigPath = join(home, ".ssh", "aws-view.config");
  store = new FileSshConfigStore(settings, new NodeRunner(), storage, home);
});

describe("FileSshConfigStore", () => {
  test("adds the Include line at the top once, after a backup", async () => {
    await mkdir(join(home, ".ssh"));
    await writeFile(userConfig(), "Host work\n  User me\n");
    expect(await store.hasInclude()).toBe(false);
    await store.addInclude();
    expect(await readFile(userConfig(), "utf8")).toBe(
      "# Added by AWS View\nInclude ~/.ssh/aws-view.config\n\nHost work\n  User me\n",
    );
    expect(await readFile(`${userConfig()}.aws-view.bak`, "utf8")).toBe("Host work\n  User me\n");
    expect(await store.hasInclude()).toBe(true);
    const configured = await readFile(userConfig(), "utf8");
    await store.addInclude();
    expect(await readFile(userConfig(), "utf8")).toBe(configured);
    expect(await readFile(`${userConfig()}.aws-view.bak`, "utf8")).toBe("Host work\n  User me\n");
  });

  test("creates ~/.ssh/config when it does not exist", async () => {
    await store.addInclude();
    expect(await readFile(userConfig(), "utf8")).toBe("# Added by AWS View\nInclude ~/.ssh/aws-view.config\n\n");
    expect((await stat(userConfig())).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
  });

  test("upsertHost rewrites one host and keeps the others", async () => {
    await store.upsertHost("aws-view-i-1", "Host aws-view-i-1\n  User a");
    await store.upsertHost("aws-view-i-2", "Host aws-view-i-2\n  User b");
    await store.upsertHost("aws-view-i-1", "Host aws-view-i-1\n  User c");
    const text = await readFile(join(home, ".ssh", "aws-view.config"), "utf8");
    expect(text).toBe(
      "# Managed by AWS View: changes to this file are overwritten.\n\nHost aws-view-i-2\n  User b\n\nHost aws-view-i-1\n  User c\n",
    );
  });

  test("ensureKeyPair creates an ed25519 key once", async () => {
    const pair = await store.ensureKeyPair();
    expect(pair).toEqual({ privateKey: join(storage, "id_ed25519"), publicKey: join(storage, "id_ed25519.pub") });
    expect((await stat(pair.privateKey)).mode & 0o777).toBe(0o600);
    expect(await readFile(pair.publicKey, "utf8")).toMatch(/^ssh-ed25519 \S+ aws-view\n$/);
    const before = await readFile(pair.privateKey, "utf8");
    await store.ensureKeyPair();
    expect(await readFile(pair.privateKey, "utf8")).toBe(before);
    expect(store.knownHostsFile).toBe(join(storage, "known_hosts"));
  });
});
