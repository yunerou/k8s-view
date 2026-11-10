import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { McpHttpServer } from "../../../../src/infra/mcp/McpHttpServer";
import { bridgeHome, buildBridge } from "../../helpers/bridge";
import { gitRepo } from "../../helpers/fakes";
import { rawJob } from "../../helpers/gitlab";
import { mcpFixture, P } from "../../helpers/mcp";

let bundle: Awaited<ReturnType<typeof buildBridge>>;
beforeAll(async () => {
  bundle = await buildBridge();
});
afterAll(async () => {
  await bundle.dispose();
});
async function connect(home: string, cwd: string) {
  const client = new Client({ name: "stdio-e2e", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle.path, "--cwd", cwd],
    env: { HOME: home, USERPROFILE: home, PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport as Parameters<Client["connect"]>[0]);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return client;
}
const names = [
  "list_repos",
  "list_pipelines",
  "get_pipeline",
  "get_job",
  "get_job_log",
  "retry_pipeline",
  "cancel_pipeline",
  "retry_job",
  "cancel_job",
  "play_job",
  "run_pipeline",
];
it("runs SDK Client → standalone bridge → real HTTP → fake GitLab, including denied/allowed mutations and reload", async () => {
  const home = await bridgeHome();
  const f = mcpFixture();
  let server = new McpHttpServer(f.tools);
  let client: Client | undefined;
  try {
    const endpoint = await server.start();
    await home.publish(endpoint.port, [home.cwd], process.pid, endpoint.secret);
    client = await connect(home.home, home.cwd);
    await client.ping();
    const catalog = await client.listTools();
    expect(catalog.tools.map((t) => t.name).sort()).toEqual([...names].sort());
    expect(catalog.tools.find((t) => t.name === "retry_job")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(catalog.tools.find((t) => t.name === "get_job")?.annotations).toMatchObject({ readOnlyHint: true });
    const repos = await client.callTool({ name: "list_repos", arguments: {} });
    expect(repos.content).toMatchObject([{ text: expect.stringContaining('"isDefault":true') }]);
    const logs = await client.callTool({ name: "get_job_log", arguments: { jobId: 100 } });
    expect(logs.content).toMatchObject([{ text: expect.stringContaining("hello\\nworld") }]);
    f.confirmer.confirm.mockResolvedValue(false);
    expect(await client.callTool({ name: "retry_job", arguments: { jobId: 100 } })).toHaveProperty("isError", true);
    expect(f.api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    f.confirmer.confirm.mockResolvedValue(true);
    f.api.route(`POST ${P}/jobs/100/retry`, rawJob({ id: 101 }));
    expect(await client.callTool({ name: "retry_job", arguments: { jobId: 100 } })).not.toHaveProperty("isError");
    expect(f.api.callsTo("POST", `${P}/jobs/100/retry`)).toHaveLength(1);
    expect(f.now).toHaveBeenCalledOnce();
    await server.stop();
    server = new McpHttpServer(f.tools);
    const next = await server.start();
    expect(next.secret).not.toBe(endpoint.secret);
    await home.publish(next.port, [home.cwd], process.pid, next.secret);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...names].sort());
    expect(await client.callTool({ name: "get_job", arguments: { jobId: 100 } })).not.toHaveProperty("isError");
  } finally {
    await client?.close();
    await server.stop();
    f.dispose();
    await home.dispose();
  }
});
it("isolates cwd and confirmation targets across two simultaneous bridge clients", async () => {
  const home = await bridgeHome();
  const f = mcpFixture();
  const server = new McpHttpServer(f.tools);
  const clients: Client[] = [];
  try {
    const a = join(home.cwd, "web");
    const b = join(home.cwd, "api");
    await Promise.all([mkdir(a), mkdir(b)]);
    f.source.set([
      { ...gitRepo("web", "git@gitlab.com:team/web.git"), rootUri: pathToFileURL(a).href },
      { ...gitRepo("api", "git@gitlab.com:team/api.git"), rootUri: pathToFileURL(b).href },
    ]);
    f.api.route("GET /projects/team%2Fapi/jobs/100", rawJob());
    const e = await server.start();
    await home.publish(e.port, [home.cwd], process.pid, e.secret);
    clients.push(...(await Promise.all([connect(home.home, a), connect(home.home, b)])));
    const results = await Promise.all(clients.map((client) => client.callTool({ name: "list_repos", arguments: {} })));
    for (let i = 0; i < 2; i++) {
      const content = results[i]!.content as { text: string }[];
      const repos = JSON.parse(content[0]!.text) as { name: string; isDefault: boolean }[];
      expect(repos.find((r) => r.isDefault)?.name).toBe(i === 0 ? "web" : "api");
    }
    f.confirmer.confirm.mockImplementation(async (_title, detail) => detail.includes("team/api"));
    f.api.route("POST /projects/team%2Fapi/jobs/100/retry", rawJob());
    const actions = await Promise.all(
      clients.map((client) => client.callTool({ name: "retry_job", arguments: { jobId: 100 } })),
    );
    expect(actions[0]).toHaveProperty("isError", true);
    expect(actions[1]).not.toHaveProperty("isError");
    expect(f.api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/projects/team%2Fapi/jobs/100/retry",
    ]);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.stop();
    f.dispose();
    await home.dispose();
  }
});
