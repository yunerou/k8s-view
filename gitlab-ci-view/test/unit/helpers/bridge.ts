import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, vi } from "vitest";

export async function buildBridge() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-bridge-test-"));
  const path = join(directory, "mcp-bridge.js");
  const result = await build({
    entryPoints: [resolve("src/bridge/mcp-bridge.ts")],
    outfile: path,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs).some((p) => p.includes("node_modules"))).toBe(false);
  return {
    directory,
    path,
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function bridgeHome() {
  const home = await mkdtemp(join(tmpdir(), "mcp-home-"));
  const cwd = join(home, "Việt Nam workspace");
  await mkdir(cwd);
  return {
    home,
    cwd,
    async publish(port: number, folders: string[] = [cwd], pid = process.pid, secret = "a".repeat(64)) {
      const path = join(home, ".gitlab-ci-view", "mcp", `${pid}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, pid, port, secret, workspaceFolders: folders }));
      return path;
    },
    async dispose() {
      await rm(home, { recursive: true, force: true });
    },
  };
}
export function spawnBridge(path: string, home: string, args: string[] = [], nodeArgs: string[] = []) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [...nodeArgs, path, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: "pipe",
  });
  const lines: Record<string, unknown>[] = [];
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    output += data;
    let end = output.indexOf("\n");
    while (end >= 0) {
      lines.push(JSON.parse(output.slice(0, end)));
      output = output.slice(end + 1);
      end = output.indexOf("\n");
    }
  });
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  return {
    child,
    lines,
    get stderr() {
      return stderr;
    },
    send(value: unknown) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    async response(id: unknown) {
      await vi.waitFor(() => expect(lines.some((line) => line["id"] === id)).toBe(true));
      return lines.find((line) => line["id"] === id)!;
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}
export async function fakeHttp(
  handler: (rpc: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    await handler(JSON.parse(Buffer.concat(chunks).toString()), req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async dispose() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
export function sendResult(res: ServerResponse, id: unknown, result: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }, null, 2));
}
