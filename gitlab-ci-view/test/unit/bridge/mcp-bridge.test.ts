import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { bridgeHome, buildBridge, fakeHttp, sendResult, spawnBridge } from "../helpers/bridge";

let bundle: Awaited<ReturnType<typeof buildBridge>>;
beforeAll(async () => {
  bundle = await buildBridge();
});
afterAll(async () => {
  await bundle.dispose();
});
const request = (id: unknown, method = "tools/list", params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
it("forwards compact JSON, id 0/string, protocol negotiation, Unicode cwd and silent notifications", async () => {
  const home = await bridgeHome();
  const seen: { method: unknown; protocol: string | undefined; cwd: string | undefined }[] = [];
  const http = await fakeHttp((rpc, req, res) => {
    seen.push({
      method: rpc["method"],
      protocol: req.headers["mcp-protocol-version"] as string | undefined,
      cwd: req.headers["x-gitlab-ci-cwd"] as string | undefined,
    });
    if (!Object.hasOwn(rpc, "id")) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendResult(res, rpc["id"], rpc["method"] === "initialize" ? { protocolVersion: "2025-11-25" } : { tools: [] });
  });
  await home.publish(http.port);
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    bridge.send(request(0, "initialize"));
    expect(await bridge.response(0)).toMatchObject({ id: 0, result: { protocolVersion: "2025-11-25" } });
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    bridge.send(request("string-id"));
    expect(await bridge.response("string-id")).toMatchObject({ id: "string-id", result: { tools: [] } });
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[0]).toMatchObject({ cwd: encodeURIComponent(home.cwd), protocol: undefined });
    expect(seen.slice(1).map((s) => s.protocol)).toEqual(["2025-11-25", "2025-11-25"]);
    expect(bridge.lines).toHaveLength(2);
    expect(bridge.stderr).not.toContain("a".repeat(64));
    bridge.child.stdin.write("bad json\n");
    expect(await bridge.response(null)).toMatchObject({ error: { code: -32700 } });
    bridge.send(request(3));
    expect(await bridge.response(3)).toHaveProperty("result");
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});
it("re-reads port and secret after reload and falls back to a sole window", async () => {
  const home = await bridgeHome();
  const first = await fakeHttp((rpc, _req, res) => sendResult(res, rpc["id"], "first"));
  const second = await fakeHttp((rpc, req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${"b".repeat(64)}`);
    sendResult(res, rpc["id"], "second");
  });
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    await home.publish(first.port, ["/not-matching"]);
    bridge.send(request(1));
    expect(await bridge.response(1)).toHaveProperty("result", "first");
    await first.dispose();
    await home.publish(second.port, [home.cwd], process.pid, "b".repeat(64));
    bridge.send(request(2));
    expect(await bridge.response(2)).toHaveProperty("result", "second");
  } finally {
    await bridge.dispose();
    await first.dispose();
    await second.dispose();
    await home.dispose();
  }
});
it("routes longest matching folders, rejects sibling prefixes, unmatched multiple windows and ties", async () => {
  const home = await bridgeHome();
  const a = await fakeHttp((rpc, _req, res) => sendResult(res, rpc["id"], "a"));
  const b = await fakeHttp((rpc, _req, res) => sendResult(res, rpc["id"], "b"));
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    await home.publish(a.port, [home.home]);
    await home.publish(b.port, [home.cwd], process.ppid);
    bridge.send(request(1));
    expect(await bridge.response(1)).toHaveProperty("result", "b");
    await home.publish(a.port, [home.cwd]);
    bridge.send(request(2));
    expect(await bridge.response(2)).toMatchObject({ error: { message: expect.stringContaining("Ambiguous") } });
    await home.publish(a.port, [`${home.cwd}-other`]);
    await home.publish(b.port, ["/elsewhere"], process.ppid);
    bridge.send(request(3));
    expect(await bridge.response(3)).toHaveProperty("error");
  } finally {
    await bridge.dispose();
    await a.dispose();
    await b.dispose();
    await home.dispose();
  }
});
it("ignores corrupted discovery, removes only dead pids and reports no window", async () => {
  const home = await bridgeHome();
  await home.publish(12345);
  const dead = await home.publish(12345, [home.cwd], 2147483647);
  const live = await home.publish(12345, [home.cwd], process.pid);
  await writeFile(live, '{"secret":"SECRET-SENTINEL"');
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    bridge.send(request(1));
    expect(await bridge.response(1)).toMatchObject({
      error: { message: expect.stringContaining("No VS Code window") },
    });
    await expect(stat(dead)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(live, "utf8")).toContain("SECRET-SENTINEL");
    expect(bridge.stderr).not.toContain("SECRET-SENTINEL");
  } finally {
    await bridge.dispose();
    await home.dispose();
  }
});
it("retries reads once, and never replays mutations or unknown tools after a dropped response", async () => {
  const home = await bridgeHome();
  let calls = 0;
  const http = await fakeHttp((_rpc, _req, res) => {
    calls++;
    res.destroy();
  });
  await home.publish(http.port);
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    bridge.send(request(1, "tools/call", { name: "get_job", arguments: { jobId: 1 } }));
    expect(await bridge.response(1)).toHaveProperty("error");
    expect(calls).toBe(2);
    bridge.send(request(2, "tools/call", { name: "retry_job", arguments: { jobId: 1 } }));
    expect(await bridge.response(2)).toMatchObject({
      error: { message: expect.stringContaining("may already have been applied") },
    });
    expect(calls).toBe(3);
    bridge.send(request(3, "tools/call", { name: "future_tool", arguments: {} }));
    await bridge.response(3);
    expect(calls).toBe(4);
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});
it.each(["text/event-stream", "text/plain", "application/json"])(
  "rejects unsupported type or malformed response: %s",
  async (type) => {
    const home = await bridgeHome();
    const http = await fakeHttp((_rpc, _req, res) => {
      res.writeHead(200, { "Content-Type": type });
      res.end("not json token-sentinel");
    });
    await home.publish(http.port);
    const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
    try {
      bridge.send(request(0));
      expect(await bridge.response(0)).toHaveProperty("error");
      expect(JSON.stringify([bridge.lines, bridge.stderr])).not.toContain("token-sentinel");
    } finally {
      await bridge.dispose();
      await http.dispose();
      await home.dispose();
    }
  },
);
it("handles concurrent requests, cancellation, EOF and SIGTERM without waiting on a modal", async () => {
  const home = await bridgeHome();
  let slowCalls = 0;
  let disconnected = false;
  const http = await fakeHttp((rpc, _req, res) => {
    if ((rpc["params"] as { name?: string } | undefined)?.name === "retry_job") {
      slowCalls++;
      res.once("close", () => {
        disconnected = true;
      });
      return;
    }
    sendResult(res, rpc["id"], {});
  });
  await home.publish(http.port);
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    bridge.send(request("slow", "tools/call", { name: "retry_job", arguments: { jobId: 1 } }));
    await vi.waitFor(() => expect(slowCalls).toBe(1));
    bridge.send(request("fast"));
    expect(await bridge.response("fast")).toHaveProperty("result");
    bridge.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } });
    expect(await bridge.response("slow")).toHaveProperty("error");
    await vi.waitFor(() => expect(disconnected).toBe(true));
    disconnected = false;
    bridge.send(request("eof", "tools/call", { name: "retry_job", arguments: { jobId: 1 } }));
    await vi.waitFor(() => expect(slowCalls).toBe(2));
    const exit = once(bridge.child, "exit");
    bridge.child.stdin.end();
    await exit;
    expect(bridge.child.exitCode).toBe(0);
    await vi.waitFor(() => expect(disconnected).toBe(true));
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});
it.each([["--cwd", "relative"], ["--bad"], ["--cwd", "/missing/gitlab-ci-test-path"]])(
  "rejects invalid startup arguments %j",
  async (...args) => {
    const home = await bridgeHome();
    const bridge = spawnBridge(bundle.path, home.home, args);
    try {
      await once(bridge.child, "exit");
      expect(bridge.child.exitCode).not.toBe(0);
      expect(bridge.lines).toEqual([]);
      expect(bridge.stderr).toContain("Cannot start");
    } finally {
      await bridge.dispose();
      await home.dispose();
    }
  },
);

it("treats EPERM as a live pid and retains its discovery file", async () => {
  const home = await bridgeHome();
  const http = await fakeHttp((rpc, _req, res) => sendResult(res, rpc["id"], {}));
  const path = await home.publish(http.port, [home.cwd], 2147483646);
  const preload = `${home.home}/pid-permissions.cjs`;
  await writeFile(
    preload,
    "const kill = process.kill; process.kill = function(pid, signal) { if (pid === 2147483646) throw Object.assign(new Error('denied'), {code:'EPERM'}); return kill.call(process, pid, signal); };\n",
  );
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd], ["--require", preload]);
  try {
    bridge.send(request(1));
    expect(await bridge.response(1)).toHaveProperty("result");
    expect((await stat(path)).isFile()).toBe(true);
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});

it("uses the process cwd when --cwd is omitted", async () => {
  const home = await bridgeHome();
  const http = await fakeHttp((rpc, req, res) =>
    sendResult(res, rpc["id"], decodeURIComponent(req.headers["x-gitlab-ci-cwd"] as string)),
  );
  await home.publish(http.port, [process.cwd()]);
  const bridge = spawnBridge(bundle.path, home.home);
  try {
    bridge.send(request(1));
    expect(await bridge.response(1)).toHaveProperty("result", process.cwd());
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});

it("retries a read after the response body disconnects, but submits a write only once", async () => {
  const home = await bridgeHome();
  let calls = 0;
  const http = await fakeHttp((_rpc, _req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10000" });
    res.write('{"jsonrpc":"2.0",');
    setTimeout(() => res.destroy(), 5);
  });
  await home.publish(http.port);
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    bridge.send(request(1));
    expect(await bridge.response(1)).toHaveProperty("error");
    expect(calls).toBe(2);
    bridge.send(request(2, "tools/call", { name: "run_pipeline", arguments: { ref: "test" } }));
    expect(await bridge.response(2)).toMatchObject({
      error: { message: expect.stringContaining("may already have been applied") },
    });
    expect(calls).toBe(3);
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});

it("SIGTERM closes a pending request promptly", async () => {
  const home = await bridgeHome();
  let started = false;
  let disconnected = false;
  const http = await fakeHttp((_rpc, _req, res) => {
    started = true;
    res.once("close", () => {
      disconnected = true;
    });
  });
  await home.publish(http.port);
  const bridge = spawnBridge(bundle.path, home.home, ["--cwd", home.cwd]);
  try {
    bridge.send(request(1, "tools/call", { name: "retry_job", arguments: { jobId: 1 } }));
    await vi.waitFor(() => expect(started).toBe(true));
    await bridge.dispose();
    await vi.waitFor(() => expect(disconnected).toBe(true));
  } finally {
    await bridge.dispose();
    await http.dispose();
    await home.dispose();
  }
});
