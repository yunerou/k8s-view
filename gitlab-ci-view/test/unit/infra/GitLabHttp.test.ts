import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { type TokenMeta, TokenStore } from "../../../src/app/TokenStore";
import { GitLabHttp, networkError } from "../../../src/infra/gitlab/GitLabHttp";
import { FakeSecrets, FakeSettings, FakeState } from "../helpers/fakes";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let base: string;
let handler: Handler;
const seen: { url: string; method: string; headers: IncomingHttpHeaders; body: string }[] = [];
let store: TokenStore;
let http: GitLabHttp;
let sleeps: number[];

const meta: TokenMeta = { expiresAt: null, scopes: ["api"], expirySource: "api", verifiedAt: "x" };
const target = () => ({ host: "local", apiUrl: base });
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const names = z.array(z.object({ name: z.string() }));

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(async () => {
  seen.length = 0;
  sleeps = [];
  store = new TokenStore(new FakeSecrets(), new FakeState());
  await store.save("local", "tok", meta);
  http = new GitLabHttp(store, new FakeSettings(), async (ms) => {
    sleeps.push(ms);
  });
});

describe("GitLabHttp.get", () => {
  test("sends the stored token, skips empty query values and reads x-next-page", async () => {
    handler = (_req, res) => json(res, 200, [{ name: "main" }], { "x-next-page": "2" });
    const r = await http.get(
      target(),
      "/projects/g%2Fp/repository/branches",
      { page: 1, per_page: 100, search: "", ref: undefined },
      names,
    );
    expect(r).toEqual({ data: [{ name: "main" }], nextPage: 2 });
    expect(seen[0]?.url).toBe("/api/v4/projects/g%2Fp/repository/branches?page=1&per_page=100");
    expect(seen[0]?.headers["private-token"]).toBe("tok");
  });

  test("an empty x-next-page means last page", async () => {
    handler = (_req, res) => json(res, 200, [], { "x-next-page": "" });
    expect((await http.get(target(), "/x", {}, names)).nextPage).toBeUndefined();
  });

  test("keeps a relative URL root of the instance", async () => {
    handler = (_req, res) => json(res, 200, []);
    await http.get({ host: "local", apiUrl: `${base}/gitlab/` }, "/user", {}, z.array(z.unknown()));
    expect(seen[0]?.url).toBe("/gitlab/api/v4/user");
  });

  test("401 with the stored token fires onUnauthorized; with an explicit token it does not", async () => {
    handler = (_req, res) => json(res, 401, { message: "401 Unauthorized" });
    const fired: string[] = [];
    http.onUnauthorized((h) => fired.push(h));
    await expect(http.get(target(), "/user", {}, names)).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
    await expect(http.get(target(), "/user", {}, names, { token: "new" })).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(seen[1]?.headers["private-token"]).toBe("new");
    expect(fired).toEqual(["local"]);
  });

  test("a host flagged invalid is not called at all", async () => {
    await store.markInvalid("local");
    await expect(http.get(target(), "/user", {}, names)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(seen).toHaveLength(0);
  });

  test("no token for the host", async () => {
    await expect(http.get({ host: "other", apiUrl: base }, "/user", {}, names)).rejects.toMatchObject({
      kind: "noToken",
    });
  });

  test("429 is retried after Retry-After", async () => {
    let n = 0;
    handler = (_req, res) =>
      n++ === 0 ? json(res, 429, { message: "slow down" }, { "retry-after": "1" }) : json(res, 200, []);
    await http.get(target(), "/x", {}, names);
    expect(sleeps).toEqual([1000]);
  });

  test("403 and schema mismatch map to typed errors", async () => {
    handler = (_req, res) => json(res, 403, { message: "403 Forbidden" });
    await expect(http.get(target(), "/x", {}, names)).rejects.toMatchObject({
      kind: "forbidden",
      message: "403 Forbidden",
    });
    handler = (_req, res) => json(res, 200, { not: "an array" });
    await expect(http.get(target(), "/x", {}, names)).rejects.toMatchObject({ kind: "invalidResponse" });
  });
});

describe("GitLabHttp.post / graphql", () => {
  test("post sends JSON", async () => {
    handler = (_req, res) => json(res, 201, { name: "ok" });
    await http.post(target(), "/projects/1/pipeline", { ref: "main" }, z.object({ name: z.string() }));
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0]!.body)).toEqual({ ref: "main" });
  });

  test("graphql returns data and turns errors into GitLabError", async () => {
    handler = (_req, res) => json(res, 200, { data: { n: 1 } });
    expect(await http.graphql(target(), "query { n }", {}, z.object({ n: z.number() }))).toEqual({ n: 1 });
    expect(seen[0]?.url).toBe("/api/graphql");
    handler = (_req, res) => json(res, 200, { errors: [{ message: "Field 'x' doesn't exist" }] });
    await expect(http.graphql(target(), "query { x }", {}, z.unknown())).rejects.toMatchObject({
      kind: "http",
      message: "Field 'x' doesn't exist",
    });
  });
});

describe("GitLabHttp.getBytes", () => {
  const log = Buffer.from("héllo world", "utf8");

  test("uses Range when the server supports it", async () => {
    handler = (req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      if (!m) {
        res.writeHead(200);
        res.end(log);
        return;
      }
      res.writeHead(206);
      res.end(log.subarray(Number(m[1])));
    };
    expect(Buffer.from(await http.getBytes(target(), "/projects/1/jobs/2/trace", 0)).toString()).toBe("héllo world");
    expect(seen[0]?.headers.range).toBeUndefined();
    expect(Buffer.from(await http.getBytes(target(), "/projects/1/jobs/2/trace", 7)).toString()).toBe("world");
    expect(seen[1]?.headers.range).toBe("bytes=7-");
  });

  test("slices locally when the server ignores Range, and 416 means nothing new", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(log);
    };
    expect(Buffer.from(await http.getBytes(target(), "/t", 7)).toString()).toBe("world");
    handler = (_req, res) => {
      res.writeHead(416);
      res.end();
    };
    expect((await http.getBytes(target(), "/t", 99)).length).toBe(0);
  });
});

describe("networkError", () => {
  test("classifies TLS failures and timeouts", () => {
    const tls = Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });
    expect(networkError("h", tls)).toMatchObject({ kind: "tls" });
    expect(networkError("h", tls).message).toContain("caFile");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(networkError("h", timeout).kind).toBe("timeout");
    const refused = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" },
    });
    expect(networkError("h", refused)).toBeInstanceOf(GitLabError);
    expect(networkError("h", refused).message).toBe("connect ECONNREFUSED");
  });
});

describe("redirects", () => {
  test("follows a same-origin 307 and keeps the token", async () => {
    handler = (req, res) =>
      req.url === "/api/v4/user"
        ? json(res, 307, {}, { Location: "/gitlab/api/v4/user" })
        : json(res, 200, [{ name: "me" }]);
    expect((await http.get(target(), "/user", {}, names)).data).toEqual([{ name: "me" }]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers["private-token"]).toBe("tok");
  });

  test("preserves the POST method and body through a 307", async () => {
    handler = (req, res) =>
      req.url === "/api/v4/x" ? json(res, 307, {}, { Location: "/gitlab/api/v4/x" }) : json(res, 200, [{ name: "ok" }]);
    await http.post(target(), "/x", { ref: "main" }, names);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe('{"ref":"main"}');
  });

  test("does not send a token to a different origin, including a different port", async () => {
    handler = (_req, res) => json(res, 307, {}, { Location: "http://127.0.0.1:1/redirected" });
    await expect(http.get(target(), "/user", {}, names)).rejects.toMatchObject({
      status: 307,
      message: expect.stringContaining("apiUrl"),
    });
    expect(seen).toHaveLength(1);
  });

  test("stops redirect loops", async () => {
    handler = (_req, res) => json(res, 307, {}, { Location: "/api/v4/user" });
    await expect(http.get(target(), "/user", {}, names)).rejects.toMatchObject({
      message: expect.stringContaining("too many redirects"),
    });
    expect(seen).toHaveLength(6);
  });

  test("does not change a POST into a GET through a 302", async () => {
    handler = (_req, res) => json(res, 302, {}, { Location: "/login" });
    await expect(http.post(target(), "/x", { ref: "main" }, names)).rejects.toMatchObject({ status: 302 });
    expect(seen).toHaveLength(1);
  });

  test("resolves the exact project ID when a proxy redirects encoded slashes", async () => {
    handler = (req, res) => {
      const url = new URL(req.url!, base);
      if (url.pathname.includes("g%2Fp")) {
        json(res, 307, {}, { Location: req.url!.replace("g%2Fp", "g/p") });
      } else if (url.pathname === "/api/v4/projects") {
        if (url.searchParams.get("page") === "1")
          json(res, 200, [{ id: 1, path_with_namespace: "other/p" }], { "x-next-page": "2" });
        else json(res, 200, [{ id: 7, path_with_namespace: "g/p" }]);
      } else if (url.pathname === "/api/v4/projects/7/pipelines") {
        json(res, 200, [{ name: "ok" }]);
      } else json(res, 404, {});
    };
    expect((await http.get(target(), "/projects/g%2Fp/pipelines", { ref: "main" }, names)).data).toEqual([
      { name: "ok" },
    ]);
    expect(seen.at(-1)?.url).toBe("/api/v4/projects/7/pipelines?ref=main");
    expect(seen.every((r) => !r.url.includes("/projects/g/p"))).toBe(true);
    seen.length = 0;
    await http.get(target(), "/projects/g%2Fp/pipelines", {}, names);
    expect(seen.some((r) => r.url.startsWith("/api/v4/projects?"))).toBe(false);
  });
});
