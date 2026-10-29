import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { KubeConfig } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { KubeApiError } from "../../../src/app/ports/ClusterApi";
import type { ExecCredentialProvider } from "../../../src/infra/kube/ExecCredentialProvider";
import type { KubeClientFactory } from "../../../src/infra/kube/KubeClientFactory";
import { KubeHttp } from "../../../src/infra/kube/KubeHttp";
import { KubeLogSource } from "../../../src/infra/kube/KubeLogSource";

// KubeClientFactory pulls in the MS extension API (requires real VS Code): replace it with an empty class; tests pass a fake.
vi.mock("../../../src/infra/kube/KubeClientFactory", () => ({ KubeClientFactory: class {} }));

let server: Server;
let http: KubeHttp;
const seen: string[] = [];
const writes: {
  method: string | undefined;
  contentType: string | undefined;
  authorization: string | undefined;
  body: unknown;
}[] = [];
let invalidated = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url?.startsWith("/write/")) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        writes.push({
          method: req.method,
          contentType: req.headers["content-type"],
          authorization: req.headers.authorization,
          body: JSON.parse(body),
        });
        const status = req.url?.endsWith("forbidden") ? 403 : req.url?.endsWith("unauthorized") ? 401 : 200;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "Status", message: status === 200 ? "ok" : "Mutation denied" }));
      });
      return;
    }
    if (req.url?.startsWith("/api/v1/namespaces/a/pods/forbidden/log")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ kind: "Status", message: 'pods "forbidden" is forbidden', reason: "Forbidden" }));
      return;
    }
    if (req.url?.startsWith("/api/v1/namespaces/a/pods/endless/log")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("first\n");
      return; // Never finishes: stops only when the client cancels.
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("line 1\nli");
    setTimeout(() => res.end("ne 2\n"), 10);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "local", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: "u", token: "unit-test-token" }],
    contexts: [{ name: "dev", cluster: "local", user: "u" }],
    currentContext: "dev",
  });
  const clients = { config: () => kc } as unknown as KubeClientFactory;
  const credentials = { invalidate: () => invalidated++ } as unknown as ExecCredentialProvider;
  http = new KubeHttp(clients, credentials);
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("KubeHttp.streamText / KubeLogSource", () => {
  test("streams chunks with the log query and resolves when the server ends", async () => {
    const logs = new KubeLogSource(http);
    const chunks: string[] = [];
    await logs.stream(
      "dev",
      { namespace: "a", pod: "web-1", container: "app", follow: true, tailLines: 10, timestamps: true },
      (c) => chunks.push(c),
      new AbortController().signal,
    );
    expect(chunks.join("")).toBe("line 1\nline 2\n");
    const url = new URL(seen.at(-1)!, "http://x");
    expect(url.pathname).toBe("/api/v1/namespaces/a/pods/web-1/log");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      container: "app",
      follow: "true",
      timestamps: "true",
      tailLines: "10",
    });
  });

  test("sinceTime replaces tailLines", async () => {
    const logs = new KubeLogSource(http);
    await logs.stream(
      "dev",
      {
        namespace: "a",
        pod: "p",
        container: "c",
        follow: false,
        tailLines: 10,
        sinceTime: "2026-10-22T00:00:00Z",
        timestamps: false,
      },
      () => undefined,
      new AbortController().signal,
    );
    const url = new URL(seen.at(-1)!, "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({ container: "c", sinceTime: "2026-10-22T00:00:00Z" });
  });

  test("HTTP errors become KubeApiError with the Status message", async () => {
    const error = await http
      .streamText("dev", "/api/v1/namespaces/a/pods/forbidden/log", {}, () => undefined, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubeApiError);
    expect(error).toMatchObject({ status: 403, message: 'pods "forbidden" is forbidden', reason: "Forbidden" });
  });

  test("abort ends an endless stream quietly", async () => {
    const logs = new KubeLogSource(http);
    const controller = new AbortController();
    const chunks: string[] = [];
    const done = logs.stream(
      "dev",
      { namespace: "a", pod: "endless", container: "c", follow: true, timestamps: false },
      (c) => {
        chunks.push(c);
        controller.abort();
      },
      controller.signal,
    );
    await expect(done).resolves.toBeUndefined();
    expect(chunks).toEqual(["first\n"]);
    expect(invalidated).toBe(0);
  });
});

describe("KubeHttp mutations", () => {
  test.each(["PATCH", "DELETE", "POST"] as const)(
    "%s sends authenticated JSON with the correct content type",
    async (method) => {
      const body = { metadata: { uid: "selected-uid" }, spec: { replicas: 3 } };
      await http.mutate("dev", "/write/resource", method, body);
      expect(writes.at(-1)).toEqual({
        method,
        contentType: method === "PATCH" ? "application/merge-patch+json" : "application/json",
        authorization: "Bearer unit-test-token",
        body,
      });
    },
  );

  test("mutation failures expose Status errors and invalidate expired credentials", async () => {
    await expect(http.mutate("dev", "/write/forbidden", "DELETE", {})).rejects.toMatchObject({
      status: 403,
      message: "Mutation denied",
    });
    const previous = invalidated;
    await expect(http.mutate("dev", "/write/unauthorized", "PATCH", {})).rejects.toMatchObject({ status: 401 });
    expect(invalidated).toBe(previous + 1);
  });
});
