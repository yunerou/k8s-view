import { describe, expect, test } from "vitest";
import { compileCommand } from "../../../src/core/command/CommandDefinition";
import { quoteArg, renderRun } from "../../../src/core/command/CommandTemplate";
import { decideExecution } from "../../../src/core/command/policy";
import { CommandSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { kinds, res } from "../helpers/fixtures";

const engine = new ExpressionEngine("safe");
const def = (cfg: unknown, origin: "builtin" | "preset" | "user" | "workspace" = "builtin") => {
  const r = compileCommand(CommandSchema.parse(cfg), origin, engine);
  if (!r.command) throw new Error(JSON.stringify(r.issues));
  return r.command;
};

const vars = {
  context: "kind-dev",
  cluster: "kind-dev",
  user: "admin",
  kubeconfig: "/home/u/.kube/config",
  timestamp: "20261022-153000",
  workspaceFolder: "/ws",
  namespace: "team-a",
  inputs: { container: "app" },
};

describe("CommandDefinition.matches", () => {
  const reconcile = def({
    id: "flux.suspend",
    title: "Suspend",
    match: [
      {
        group: "kustomize.toolkit.fluxcd.io",
        kind: "Kustomization",
        when: { path: "$.spec.suspend", op: "neq", value: true },
      },
    ],
    run: { type: "process", command: "flux", args: [] },
  });

  test("matches group/kind and when", () => {
    expect(reconcile.matches(res(kinds.kustomization, "a"))).toBe(true);
    expect(reconcile.matches(res(kinds.kustomization, "b", { spec: { suspend: true } }))).toBe(false);
    expect(reconcile.matches(res(kinds.pod, "c"))).toBe(false);
  });

  test("wildcard kind and snippets", () => {
    const any = def({
      id: "copy",
      title: "Copy",
      match: [{ group: "*", kind: "*" }],
      run: { type: "vscode", command: "x" },
    });
    expect(any.matches(res(kinds.deployment, "d"))).toBe(true);
    const snippet = def({
      id: "s",
      title: "S",
      target: "context",
      run: { type: "terminal", command: "flux", args: ["get", "all"] },
    });
    expect(snippet.isSnippet).toBe(true);
    expect(snippet.matches(res(kinds.pod, "p"))).toBe(false);
  });

  test("skipConfirm only effective for user config", () => {
    const cfg = { id: "x", title: "x", skipConfirm: true, run: { type: "kubectl", args: [] } };
    expect(def(cfg, "user").skipConfirm).toBe(true);
    expect(def(cfg, "workspace").skipConfirm).toBe(false);
  });

  test("hash changes when definition changes", () => {
    const a = def({ id: "x", title: "x", run: { type: "kubectl", args: ["get"] } }, "workspace");
    const b = def({ id: "x", title: "x", run: { type: "kubectl", args: ["delete"] } }, "workspace");
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toBe(def({ id: "x", title: "x", run: { type: "kubectl", args: ["get"] } }, "workspace").hash);
  });

  test("unknown variables are compile issues", () => {
    const r = compileCommand(
      CommandSchema.parse({ id: "x", title: "x", run: { type: "kubectl", args: ["${nmae}"] } }),
      "user",
      engine,
    );
    expect(r.command).toBeUndefined();
    expect(r.issues[0]).toMatchObject({ path: ["run", "args", 0] });
  });
});

describe("renderRun", () => {
  const pod = res(kinds.pod, "web-1", { metadata: { name: "web-1", uid: "u", labels: { app: "web" } } }, "team-a");

  test("renders process argv without shell quoting", () => {
    const c = def({
      id: "flux.reconcile",
      title: "Reconcile",
      run: {
        type: "process",
        command: "flux",
        args: [
          "reconcile",
          "${kindLower}",
          "${name}",
          "-n",
          "${namespace}",
          "--context",
          "${context}",
          "--label=${label:app}",
        ],
        cwd: "${workspaceFolder}",
        env: { FOO: "${name}" },
      },
    });
    expect(renderRun(c, pod, vars)).toEqual({
      type: "process",
      command: "flux",
      args: ["reconcile", "pod", "web-1", "-n", "team-a", "--context", "kind-dev", "--label=web"],
      cwd: "/ws",
      env: { FOO: "web-1" },
    });
  });

  test("inputs, jsonpath and truncation", () => {
    const c = def({
      id: "cron.trigger",
      title: "Trigger",
      run: {
        type: "kubectl",
        args: [
          "create",
          "job",
          "${name|trunc:40}-manual-${timestamp}",
          "-c",
          "${input:container}",
          "${$.metadata.uid}",
        ],
      },
    });
    const long = res(kinds.cronJob, "x".repeat(60), {}, "team-a");
    const out = renderRun(c, long, vars);
    expect(out.type === "kubectl" && out.args[2]).toBe(`${"x".repeat(40)}-manual-20261022-153000`);
    expect(out.type === "kubectl" && out.args[4]).toBe("app");
  });

  test("snippet uses namespace from variables", () => {
    const c = def({
      id: "s",
      title: "S",
      target: "namespace",
      run: { type: "terminal", command: "kubectl", args: ["get", "all", "-n", "${namespace}"] },
    });
    expect(renderRun(c, undefined, vars)).toMatchObject({ type: "terminal", args: ["get", "all", "-n", "team-a"] });
  });

  test("vscode args render nested strings", () => {
    const c = def({
      id: "v",
      title: "V",
      run: { type: "vscode", command: "k8sView.openManifest", args: [{ name: "${name}", n: 1 }, "${namespace}"] },
    });
    expect(renderRun(c, pod, vars)).toEqual({
      type: "vscode",
      command: "k8sView.openManifest",
      args: [{ name: "web-1", n: 1 }, "team-a"],
    });
  });
});

describe("quoteArg", () => {
  test("posix", () => {
    expect(quoteArg("web-1", "linux")).toBe("web-1");
    expect(quoteArg("--selector=app=web", "darwin")).toBe("--selector=app=web");
    expect(quoteArg("a b", "linux")).toBe("'a b'");
    expect(quoteArg("it's; rm -rf /", "linux")).toBe("'it'\\''s; rm -rf /'");
    expect(quoteArg("", "linux")).toBe("''");
  });
  test("windows", () => {
    expect(quoteArg("a b", "win32")).toBe('"a b"');
    expect(quoteArg('say "hi"', "win32")).toBe('"say \\"hi\\""');
  });
});

describe("decideExecution", () => {
  const base = {
    dangerous: false,
    hasConfirm: false,
    skipConfirm: false,
    setting: "restricted" as const,
    contextProtected: false,
  };
  test.each([
    [{}, "run"],
    [{ dangerous: true }, "block"],
    [{ dangerous: true, setting: "confirm" }, "confirm"],
    [{ dangerous: true, setting: "confirm", skipConfirm: true }, "run"],
    [{ dangerous: true, setting: "allow" }, "run"],
    [{ dangerous: true, setting: "allow", hasConfirm: true }, "run"],
    [{ dangerous: true, setting: "allow", contextProtected: true }, "confirm"],
    [{ dangerous: true, setting: "allow", skipConfirm: true, contextProtected: true }, "confirm"],
    [{ dangerous: true, setting: "restricted", contextProtected: true }, "block"],
    [{ hasConfirm: true }, "confirm"],
    [{ hasConfirm: true, skipConfirm: true }, "run"],
    [{ contextProtected: true }, "confirm"],
  ] as const)("%j → %s", (over, action) => {
    expect(decideExecution({ ...base, ...over }).action).toBe(action);
  });
});
