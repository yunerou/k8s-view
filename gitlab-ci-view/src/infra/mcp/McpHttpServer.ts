import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type McpTools, readTools, type ToolName, toolCatalog } from "../../app/mcp/McpTools";

export interface Endpoint {
  readonly port: number;
  readonly secret: string;
}

/** One authenticated, stateless SDK instance per POST; no per-client global context. */
export class McpHttpServer {
  private server: Server | undefined;
  private endpoint: Endpoint | undefined;
  private starting: Promise<Endpoint> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly active = new Map<ServerResponse, () => void>();

  constructor(private readonly tools: Pick<McpTools, "call">) {}

  async start(): Promise<Endpoint> {
    if (this.stopping) await this.stopping;
    if (this.endpoint) return this.endpoint;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async listen(): Promise<Endpoint> {
    if (this.endpoint) return this.endpoint;
    const secret = randomBytes(32).toString("hex");
    const server = createServer((req, res) => {
      void this.handle(req, res, secret);
    });
    // Modal confirmation is limited by the MCP client, not a short HTTP timeout.
    server.timeout = 0;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    }).catch((error: unknown) => {
      this.server = undefined;
      server.close();
      throw error;
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP server did not bind a TCP port");
    this.endpoint = { port: address.port, secret };
    return this.endpoint;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.shutdown();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  private async shutdown(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    for (const [response, cancel] of this.active) {
      cancel();
      response.destroy();
    }
    this.active.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
    const send = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    };
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      send(401, "Unauthorized");
      return;
    }
    const port = this.endpoint?.port;
    if (
      (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) ||
      req.headers.origin !== undefined
    ) {
      send(403, "Forbidden");
      return;
    }
    if (req.url !== "/mcp") {
      send(404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      send(405, "Method not allowed");
      return;
    }
    let cwd: string | undefined;
    const header = req.headers["x-gitlab-ci-cwd"];
    if (header !== undefined) {
      try {
        if (typeof header !== "string") throw new Error();
        cwd = decodeURIComponent(header);
        if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Error();
      } catch {
        send(400, "Invalid working directory header");
        return;
      }
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    this.active.set(res, cancel);
    // request.close also fires after a normal body read. Only premature response.close cancels.
    res.once("close", () => {
      if (!res.writableFinished) cancel();
      this.active.delete(res);
    });
    let sdk: McpServer | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) {
          send(413, "Request body too large");
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      if (cancelled || !this.server) return;
      sdk = new McpServer({ name: "gitlab-ci-view", version: "1.0.0" });
      for (const [name, tool] of Object.entries(toolCatalog)) {
        const readOnly = readTools.has(name);
        sdk.registerTool(
          name,
          {
            description: tool.description,
            inputSchema: tool.schema,
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint: !readOnly,
              idempotentHint: readOnly,
              openWorldHint: true,
            },
          },
          async (args: unknown) =>
            this.tools.call(name as ToolName, args, {
              ...(cwd !== undefined ? { cwd } : {}),
              isCancelled: () => cancelled,
            }),
        );
      }
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      // SDK defaults to no session generator (stateless); adapt its optional callbacks for exactOptionalPropertyTypes.
      await sdk.connect(transport as Parameters<McpServer["connect"]>[0]);
      const current = sdk;
      res.once("close", () => {
        void current.close().catch(() => {});
      });
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent && !res.destroyed) send(500, "MCP request failed");
    } finally {
      // handleRequest resolves after writing the response, including a pending tool call.
      if (res.writableFinished || res.destroyed) {
        this.active.delete(res);
        await sdk?.close().catch(() => {});
      }
    }
  }
}
