import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpContext } from "../../../../src/app/mcp/McpTools";
import { type Endpoint, McpHttpServer } from "../../../../src/infra/mcp/McpHttpServer";
import { rawJob } from "../../helpers/gitlab";
import { context, mcpFixture, P } from "../../helpers/mcp";

let f: ReturnType<typeof mcpFixture>;
let server: McpHttpServer;
let endpoint: Endpoint;
let url: string;
let headers: Record<string, string>;
beforeEach(async () => {
  f = mcpFixture();
  server = new McpHttpServer(f.tools);
  endpoint = await server.start();
  url = `http://127.0.0.1:${endpoint.port}/mcp`;
  headers = {
    Authorization: `Bearer ${endpoint.secret}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Gitlab-Ci-Cwd": encodeURIComponent(context.cwd),
  };
});
afterEach(async () => {
  await server.stop();
  f.dispose();
});
const rpc = (name: string, args: unknown = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name, arguments: args } });
it("rejects auth, rebinding, browser origins, wrong paths and unsupported methods", async () => {
  const cases: [string, RequestInit, number][] = [
    [url, { method: "POST", headers: {} }, 401],
    [url, { method: "POST", headers: { ...headers, Authorization: "Bearer wrong" } }, 401],
    [url, { method: "POST", headers: { ...headers, Origin: "http://localhost" } }, 403],
    [url.replace("/mcp", "/bad"), { method: "POST", headers }, 404],
    [url, { method: "GET", headers }, 405],
    [url, { method: "DELETE", headers }, 405],
    [url, { method: "POST", headers: { ...headers, "X-Gitlab-Ci-Cwd": "%ZZ" } }, 400],
    [url, { method: "POST", headers: { ...headers, "X-Gitlab-Ci-Cwd": "relative" } }, 400],
  ];
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { ...headers, Host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  expect(hostStatus).toBe(403);
  for (const [target, init, status] of cases) {
    const response = await fetch(target, init);
    expect(response.status).toBe(status);
    await response.arrayBuffer();
  }
});
it("limits request bodies, rejects malformed JSON and lets SDK handle invalid RPC/schema", async () => {
  const large = await fetch(url, { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) });
  expect(large.status).toBe(413);
  await large.arrayBuffer();
  const malformed = await fetch(url, { method: "POST", headers, body: "{" });
  expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
  const invalid = await fetch(url, { method: "POST", headers, body: rpc("get_job", { jobId: -1 }) });
  expect(await invalid.json()).toMatchObject({ result: { isError: true } });
  const method = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "nonexistent" }),
  });
  expect(await method.json()).toMatchObject({ id: "a", error: { code: -32601 } });
});
it("marks premature response disconnect as cancelled, while a normal body read permits a write", async () => {
  let requestContext: McpContext | undefined;
  const call = f.tools.call.bind(f.tools);
  vi.spyOn(f.tools, "call").mockImplementation((name, args, context) => {
    requestContext = context;
    return call(name, args, context);
  });
  let allow: (value: boolean) => void = () => {};
  f.confirmer.confirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const abort = new AbortController();
  const pending = fetch(url, {
    method: "POST",
    headers,
    body: rpc("retry_job", { jobId: 100 }),
    signal: abort.signal,
  }).catch(() => undefined);
  await vi.waitFor(() => expect(f.confirmer.confirm).toHaveBeenCalledOnce());
  abort.abort();
  await pending;
  await vi.waitFor(() => expect(requestContext?.isCancelled()).toBe(true));
  allow(true);
  await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledOnce());
  expect(f.api.calls.filter((c) => c.method === "POST")).toEqual([]);
  f.confirmer.confirm.mockResolvedValue(true);
  f.api.route(`POST ${P}/jobs/100/retry`, rawJob());
  const response = await fetch(url, { method: "POST", headers, body: rpc("retry_job", { jobId: 100 }) });
  expect(await response.json()).toMatchObject({ result: { content: [{ type: "text" }] } });
  expect(f.api.callsTo("POST", `${P}/jobs/100/retry`)).toHaveLength(1);
});
it("stop cancels pending confirmations and repeated start rotates credentials", async () => {
  let allow: (value: boolean) => void = () => {};
  f.confirmer.confirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const pending = fetch(url, { method: "POST", headers, body: rpc("retry_job", { jobId: 100 }) }).catch(
    () => undefined,
  );
  await vi.waitFor(() => expect(f.confirmer.confirm).toHaveBeenCalledOnce());
  await server.stop();
  await pending;
  allow(true);
  await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledOnce());
  expect(f.api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  const [a, b] = await Promise.all([server.start(), server.start()]);
  expect(a).toEqual(b);
  expect(a.secret).not.toBe(endpoint.secret);
  await Promise.all([server.stop(), server.stop()]);
});
it("keeps Unicode cwd isolated between simultaneous requests", async () => {
  const seen: string[] = [];
  const tools = new McpHttpServer({
    call: async (_name, _args, c) => {
      seen.push(c.cwd!);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { content: [{ type: "text", text: c.cwd! }] };
    },
  });
  try {
    const e = await tools.start();
    const values = ["/ws/Việt Nam", "/ws/other"];
    const results = await Promise.all(
      values.map(async (cwd) => {
        const res = await fetch(`http://127.0.0.1:${e.port}/mcp`, {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${e.secret}`, "X-Gitlab-Ci-Cwd": encodeURIComponent(cwd) },
          body: rpc("list_repos"),
        });
        return res.json();
      }),
    );
    expect(seen).toEqual(values);
    results.forEach((r, i) => {
      expect(r).toMatchObject({ result: { content: [{ text: values[i] }] } });
    });
  } finally {
    await tools.stop();
  }
});
