import { beforeEach, describe, expect, test } from "vitest";
import { LogSession, type LogTarget, logTargetFor } from "../../../src/app/LogSession";
import { type LogRequest, LogSource } from "../../../src/app/ports/LogSource";
import { ClusterContext } from "../../../src/core/context/ClusterContext";
import { stripAnsi } from "../../../src/core/logs/LogFormat";
import type { KubeResource } from "../../../src/core/resource/KubeResource";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { kinds, res } from "../helpers/fixtures";

interface Call {
  readonly req: LogRequest;
  readonly onData: (chunk: string) => void;
  readonly signal: AbortSignal;
  end(error?: Error): void;
}

class FakeLogs extends LogSource {
  calls: Call[] = [];
  stream(_context: string, req: LogRequest, onData: (c: string) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => resolve());
      this.calls.push({ req, onData, signal, end: (e) => (e ? reject(e) : resolve()) });
    });
  }
  open(): Call[] {
    return this.calls.filter((c) => !c.signal.aborted);
  }
  find(pod: string, container: string): Call {
    const call = [...this.calls].reverse().find((c) => c.req.pod === pod && c.req.container === container);
    if (!call) throw new Error(`no stream for ${pod}/${container}`);
    return call;
  }
}

const POD = { group: "", kind: "Pod" };
const ctx = new ClusterContext("dev", "c", "u", { type: "single", name: "a" }, false);
const tick = () => new Promise((r) => setTimeout(r, 10));

const running = (name: string, restartCount = 0) => ({ name, restartCount, state: { running: {} } });

function pod(name: string, labels: Record<string, string>, statuses: object[], containers = ["app"]): KubeResource {
  return res(
    kinds.pod,
    name,
    {
      metadata: { name, uid: `uid-${name}`, labels },
      spec: { containers: containers.map((c) => ({ name: c, image: "img" })) },
      status: { containerStatuses: statuses },
    },
    "a",
  );
}

let source: FakeResourceSource;
let logs: FakeLogs;
let lines: string[];

function session(target: Omit<LogTarget, "context" | "namespace">): LogSession {
  const s = new LogSession(
    { context: ctx, namespace: "a", ...target },
    { tailLines: 50, timestamps: false, highlight: false, retryDelayMs: 1 },
    source,
    logs,
    { line: (t) => lines.push(stripAnsi(t)) },
  );
  s.start();
  return s;
}

beforeEach(() => {
  source = new FakeResourceSource();
  source.addKind(kinds.pod);
  logs = new FakeLogs();
  lines = [];
});

describe("LogSession", () => {
  test("workload: streams every container of matching pods with pod/container prefix", async () => {
    source.set(POD, "a", [
      pod("web-1", { app: "web" }, [running("app"), running("proxy")], ["app", "proxy"]),
      pod("web-2", { app: "web" }, [running("app"), running("proxy")], ["app", "proxy"]),
      pod("db-1", { app: "db" }, [running("app")]),
    ]);
    const s = session({ title: "deployment/web", selector: { matchLabels: { app: "web" } } });
    expect(source.active()).toEqual(["/Pod|a"]);
    expect(logs.open().map((c) => `${c.req.pod}/${c.req.container}`)).toEqual([
      "web-1/app",
      "web-1/proxy",
      "web-2/app",
      "web-2/proxy",
    ]);
    expect(logs.calls[0]!.req).toEqual({
      namespace: "a",
      pod: "web-1",
      container: "app",
      follow: true,
      timestamps: false,
      tailLines: 50,
    });
    logs.find("web-2", "proxy").onData("GET /health 200\nGET / ");
    logs.find("web-2", "proxy").onData("404\n");
    expect(lines).toContain("web-2/proxy GET /health 200");
    expect(lines).toContain("web-2/proxy GET / 404");
    expect(lines).toContain("+ web-1/app");
    s.dispose();
    expect(logs.open()).toEqual([]);
    expect(source.active()).toEqual([]);
  });

  test("new pods are picked up, deleted pods are closed", () => {
    const first = pod("web-1", { app: "web" }, [running("app")]);
    source.set(POD, "a", [first]);
    session({ title: "deployment/web", selector: { matchLabels: { app: "web" } } });
    expect(logs.open()).toHaveLength(1);
    source.set(POD, "a", [first, pod("web-2", { app: "web" }, [running("app")])]);
    expect(logs.open().map((c) => c.req.pod)).toEqual(["web-1", "web-2"]);
    source.set(POD, "a", [pod("web-2", { app: "web" }, [running("app")])]);
    expect(logs.open().map((c) => c.req.pod)).toEqual(["web-2"]);
    expect(lines).toContain("- web-1/app — pod web-1 is gone");
  });

  test("pod: container prefix; single container: no prefix; waiting containers wait", () => {
    source.set(POD, "a", [pod("p", {}, [running("app"), { name: "init", state: { waiting: {} } }], ["app", "init"])]);
    const s = session({ title: "pod/p", pod: "p" });
    expect(logs.open().map((c) => c.req.container)).toEqual(["app"]);
    logs.find("p", "app").onData("hello\n");
    expect(lines).toContain("app hello");
    s.dispose();

    lines = [];
    session({ title: "pod/p -c app", pod: "p", container: "app" });
    logs.find("p", "app").onData("solo\n");
    expect(lines).toContain("solo");
  });

  test("nothing until pods are listed; then a waiting notice when none match", () => {
    session({ title: "deployment/web", selector: { matchLabels: { app: "web" } } });
    expect(lines).toHaveLength(1);
    source.set(POD, "a", []);
    expect(lines.at(-1)).toMatch(/No matching pods yet/);
  });

  test("stream cut while the container still runs: reconnects with sinceTime", async () => {
    source.set(POD, "a", [pod("p", {}, [running("app")])]);
    session({ title: "pod/p", pod: "p" });
    logs.find("p", "app").onData("partial");
    logs.find("p", "app").end();
    await tick();
    expect(lines).toContain("app partial");
    const again = logs.find("p", "app");
    expect(logs.calls).toHaveLength(2);
    expect(again.req.sinceTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(again.req.tailLines).toBeUndefined();
  });

  test("terminated container: stream ends; restarted container opens again", async () => {
    const stopped = pod("p", {}, [{ name: "app", restartCount: 0, state: { terminated: {} } }]);
    source.set(POD, "a", [stopped]);
    session({ title: "pod/p", pod: "p" });
    logs.find("p", "app").end();
    await tick();
    expect(logs.calls).toHaveLength(1);
    expect(lines.at(-1)).toBe("- app — stream ended");
    source.set(POD, "a", [pod("p", {}, [running("app", 1)])]);
    expect(logs.calls).toHaveLength(2);
    expect(lines).toContain("↻ app restarted (#1)");
  });

  test("errors are reported and retried with backoff only while running", async () => {
    source.set(POD, "a", [pod("p", {}, [running("app")])]);
    session({ title: "pod/p", pod: "p" });
    logs.find("p", "app").end(new Error("connection reset"));
    await tick();
    expect(lines).toContain("! app: connection reset");
    expect(logs.calls).toHaveLength(2);
  });

  test("transient watch error keeps streams open and does not replay logs", () => {
    const known = pod("web-1", { app: "web" }, [running("app")]);
    source.set(POD, "a", [known]);
    session({ title: "deployment/web", selector: { matchLabels: { app: "web" } } });
    expect(logs.open()).toHaveLength(1);
    source.data.delete("/Pod|a");
    source.setState(POD, "a", { state: "error", message: "connection reset" });
    expect(logs.open()).toHaveLength(1);
    expect(lines.some((l) => l.includes("is gone"))).toBe(false);
    source.states.delete("/Pod|a");
    source.set(POD, "a", [known]);
    expect(logs.calls).toHaveLength(1);
  });

  test("forbidden pod list: falls back to the known pod object", () => {
    const known = pod("p", {}, [running("app")]);
    source.setState(POD, "a", { state: "forbidden", message: "pods is forbidden" });
    session({ title: "pod/p", pod: "p", podObject: known });
    expect(logs.open()).toHaveLength(1);
  });
});

describe("logTargetFor", () => {
  test("pod, workload selector, kinds without logs", () => {
    const p = res(kinds.pod, "p", {}, "a");
    expect(logTargetFor(ctx, p)).toMatchObject({ pod: "p", title: "pod/p", podObject: p });
    expect(logTargetFor(ctx, p, "app")).toMatchObject({ pod: "p", container: "app", title: "pod/p -c app" });
    const d = res(kinds.deployment, "web", { spec: { selector: { matchLabels: { app: "web" } } } }, "a");
    expect(logTargetFor(ctx, d)).toMatchObject({ title: "deployment/web", selector: { matchLabels: { app: "web" } } });
    expect(logTargetFor(ctx, res(kinds.configMap, "c", {}, "a"))).toBeUndefined();
  });
});
