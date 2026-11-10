import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { BridgeInstaller } from "../../../../src/infra/mcp/BridgeInstaller";
import { DiscoveryFile } from "../../../../src/infra/mcp/DiscoveryFile";

it("publishes atomically with private POSIX modes, updates folders and removes its own discovery", async () => {
  const base = await mkdtemp(join(tmpdir(), "mcp-files-"));
  const file = new DiscoveryFile(join(base, "home"));
  try {
    const endpoint = { port: 12345, secret: "a".repeat(64) };
    await file.publish(endpoint, ["/ws/Việt Nam"]);
    expect(JSON.parse(await readFile(file.path, "utf8"))).toEqual({
      version: 1,
      pid: process.pid,
      ...endpoint,
      workspaceFolders: ["/ws/Việt Nam"],
    });
    if (process.platform !== "win32") {
      expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    }
    await file.publish({ ...endpoint, port: 23456 }, ["/other"]);
    expect(JSON.parse(await readFile(file.path, "utf8"))).toMatchObject({ port: 23456, workspaceFolders: ["/other"] });
    expect(await readdir(dirname(file.path))).toEqual([`${process.pid}.json`]);
    await file.remove();
    await file.remove();
    await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
it("installs a stable standalone bridge only when content changes, including concurrent installs", async () => {
  const base = await mkdtemp(join(tmpdir(), "mcp-install-"));
  try {
    const source = join(base, "source.js");
    await writeFile(source, "first");
    const installer = new BridgeInstaller(source, join(base, "home"));
    await Promise.all(Array.from({ length: 8 }, () => installer.install()));
    expect(await readFile(installer.path, "utf8")).toBe("first");
    const modified = (await stat(installer.path)).mtimeMs;
    await installer.install();
    expect((await stat(installer.path)).mtimeMs).toBe(modified);
    await writeFile(source, "second");
    await installer.install();
    expect(await readFile(installer.path, "utf8")).toBe("second");
    expect(await readdir(dirname(installer.path))).toEqual(["mcp-bridge.js"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
