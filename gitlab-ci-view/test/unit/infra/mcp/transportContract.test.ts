import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { McpHttpServer } from "../../../../src/infra/mcp/McpHttpServer";

const servers: McpHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

it("negotiates stateless HTTP, acknowledges notifications and keeps each tool response alive", async () => {
  const server = new McpHttpServer({
    call: async (_name, _args, context) => ({ content: [{ type: "text", text: context.cwd ?? "empty" }] }),
  });
  servers.push(server);
  const { port, secret } = await server.start();
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const headers = { Authorization: `Bearer ${secret}`, "X-Gitlab-Ci-Cwd": encodeURIComponent("/workspace/Việt Nam") };
  const client = new Client({ name: "contract", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  try {
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    expect(transport.sessionId).toBeUndefined();
    await client.ping();
    expect((await client.listTools()).tools).toHaveLength(11);
    expect(await client.callTool({ name: "list_repos", arguments: {} })).toMatchObject({
      content: [{ text: "/workspace/Việt Nam" }],
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  } finally {
    await client.close();
  }
});
