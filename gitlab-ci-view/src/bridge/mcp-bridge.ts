/** Standalone stdio entry: only Node built-ins and fetch, no SDK or VS Code. */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { containsPath } from "../app/mcp/repoResolver";

interface Discovery {
  version: 1;
  pid: number;
  port: number;
  secret: string;
  workspaceFolders: string[];
}
interface Rpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; requestId?: unknown };
}
const readTools = new Set(["list_repos", "list_pipelines", "get_pipeline", "get_job", "get_job_log"]);
const stderr = (message: string) => process.stderr.write(`GitLab CI View MCP: ${message}\n`);
const stdout = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const errorResponse = (id: unknown, code: number, message: string) =>
  stdout({ jsonrpc: "2.0", id, error: { code, message } });
const hasId = (value: Rpc) => Object.hasOwn(value, "id");
const isRequest = (value: Rpc) => hasId(value) && typeof value.method === "string";
const key = (id: unknown) => JSON.stringify(id);

function validDiscovery(value: unknown): value is Discovery {
  if (!value || typeof value !== "object") return false;
  const d = value as Discovery;
  return (
    d.version === 1 &&
    Number.isSafeInteger(d.pid) &&
    d.pid > 0 &&
    Number.isSafeInteger(d.port) &&
    d.port > 0 &&
    d.port <= 65535 &&
    typeof d.secret === "string" &&
    /^[a-f0-9]{64}$/.test(d.secret) &&
    Array.isArray(d.workspaceFolders) &&
    d.workspaceFolders.every((p) => typeof p === "string" && isAbsolute(p) && !p.includes("\0"))
  );
}

async function discover(cwd: string): Promise<Discovery> {
  const directory = join(homedir(), ".gitlab-ci-view", "mcp");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    throw new Error(`No VS Code window with GitLab CI View is open for ${cwd}`);
  }
  const windows: Discovery[] = [];
  for (const file of files.filter((f) => /^\d+\.json$/.test(f))) {
    const path = join(directory, file);
    let d: unknown;
    try {
      d = JSON.parse(await readFile(path, "utf8"));
    } catch {
      stderr("Ignoring unreadable or malformed discovery file");
      continue;
    }
    if (!validDiscovery(d) || file !== `${d.pid}.json`) {
      stderr("Ignoring invalid discovery file");
      continue;
    }
    try {
      process.kill(d.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EPERM") continue;
    }
    windows.push(d);
  }
  const scores = windows.map((window) => ({
    window,
    length: Math.max(
      -1,
      ...window.workspaceFolders
        .filter((folder) => containsPath(folder, cwd))
        .map((folder) => normalize(folder).length),
    ),
  }));
  const longest = Math.max(-1, ...scores.map((s) => s.length));
  const best = scores.filter((s) => s.length === longest && longest >= 0);
  if (best.length === 1) return best[0]!.window;
  if (!best.length && windows.length === 1) return windows[0]!;
  if (!windows.length) throw new Error(`No VS Code window with GitLab CI View is open for ${cwd}`);
  throw new Error(
    `Ambiguous VS Code windows for ${cwd}. Use --cwd with a unique workspace or close duplicate windows.`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--cwd" || !isAbsolute(args[1]!)))
    throw new Error("Usage: mcp-bridge.js [--cwd <absolute-existing-directory>]");
  const cwd = args[1] ?? process.cwd();
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
    throw new Error("Working directory must be an existing directory");
  let protocolVersion: string | undefined;
  let stopping = false;
  const active = new Map<string | undefined, AbortController>();
  const controllers = new Set<AbortController>();
  const stop = () => {
    stopping = true;
    for (const controller of controllers) controller.abort();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.once("close", stop);

  async function forward(rpc: Rpc): Promise<void> {
    if (rpc.method === "notifications/cancelled") {
      active.get(key(rpc.params?.requestId))?.abort();
      return;
    }
    const request = isRequest(rpc);
    const controller = new AbortController();
    controllers.add(controller);
    const requestKey = request ? key(rpc.id) : undefined;
    if (request) active.set(requestKey, controller);
    const canRetry =
      rpc.method === "initialize" ||
      rpc.method === "ping" ||
      rpc.method === "tools/list" ||
      (rpc.method === "tools/call" && typeof rpc.params?.name === "string" && readTools.has(rpc.params.name));
    try {
      for (let attempt = 0; ; attempt++) {
        const endpoint = await discover(cwd);
        if (controller.signal.aborted) throw new Error("Request cancelled");
        let response: Response;
        try {
          response = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${endpoint.secret}`,
              "X-Gitlab-Ci-Cwd": encodeURIComponent(cwd),
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
            },
            body: JSON.stringify(rpc),
          });
        } catch {
          if (!controller.signal.aborted && canRetry && attempt === 0) continue;
          throw new Error(
            controller.signal.aborted
              ? "Request cancelled"
              : "Connection failed. Check GitLab status before retrying actions; the action may already have been applied.",
          );
        }
        if (response.status === 202 && !request) {
          await response.body?.cancel();
          return;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`HTTP transport error ${response.status}. Check GitLab status before retrying actions.`);
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          await response.body?.cancel();
          throw new Error("Invalid HTTP response content type; expected application/json");
        }
        let raw: string;
        try {
          raw = await response.text();
        } catch {
          if (!controller.signal.aborted && canRetry && attempt === 0) continue;
          throw new Error(
            "Response connection lost. Check GitLab status before retrying actions; the action may already have been applied.",
          );
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new Error("Invalid JSON in HTTP response");
        }
        if (!request) return;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          body["jsonrpc"] !== "2.0" ||
          body["id"] !== rpc.id ||
          Object.hasOwn(body, "result") === Object.hasOwn(body, "error")
        )
          throw new Error("Invalid JSON-RPC response");
        if (rpc.method === "initialize" && body["result"] && typeof body["result"] === "object") {
          const version = (body["result"] as Record<string, unknown>)["protocolVersion"];
          if (typeof version !== "string") throw new Error("Missing negotiated protocol version");
          if (protocolVersion && version !== protocolVersion)
            throw new Error("Protocol changed; restart the MCP client");
          protocolVersion = version;
        }
        if (!stopping) stdout(body);
        return;
      }
    } catch (error) {
      // Only errors constructed here are reported; never include fetch errors, raw bodies or discovery secrets.
      const message = error instanceof Error ? error.message : "MCP transport failed";
      stderr(message);
      if (request && !stopping) errorResponse(rpc.id, -32000, message);
    } finally {
      controllers.delete(controller);
      if (request && active.get(requestKey) === controller) active.delete(requestKey);
    }
  }

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let rpc: Rpc;
    try {
      rpc = JSON.parse(line);
    } catch {
      errorResponse(null, -32700, "Parse error");
      return;
    }
    if (
      !rpc ||
      typeof rpc !== "object" ||
      Array.isArray(rpc) ||
      rpc.jsonrpc !== "2.0" ||
      (rpc.method !== undefined && typeof rpc.method !== "string")
    ) {
      errorResponse(null, -32600, "Invalid request");
      return;
    }
    void forward(rpc);
  });
}

void main().catch(() => {
  stderr("Cannot start bridge. Use mcp-bridge.js [--cwd <absolute-existing-directory>]");
  process.exitCode = 1;
});
