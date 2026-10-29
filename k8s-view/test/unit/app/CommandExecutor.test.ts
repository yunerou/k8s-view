import { beforeEach, describe, expect, test, vi } from "vitest";
import { CancellationTokenSource } from "vscode";
import { CommandExecutor } from "../../../src/app/CommandExecutor";
import { ContextService } from "../../../src/app/ContextService";
import { type InputOptions, Prompter } from "../../../src/app/ports/Prompter";
import {
  type BatchRunner,
  CommandInvoker,
  KubectlRunner,
  type ProcessOutcome,
  ProcessRunner,
  type ProcessSpec,
  TerminalRunner,
  WorkspaceInfo,
} from "../../../src/app/ports/Runners";
import { CommandAllowlist } from "../../../src/core/command/allowlist";
import { compileCommand } from "../../../src/core/command/CommandDefinition";
import type { ConfigOrigin } from "../../../src/core/config/origin";
import { CommandSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

class FakePrompter extends Prompter {
  picks: string[] = [];
  inputs: (string | undefined)[] = [];
  confirms: boolean[] = [];
  approve = true;
  log: string[] = [];
  async pick(title: string, items: readonly string[]) {
    this.log.push(`pick:${title}:${items.join(",")}`);
    return this.picks.shift();
  }
  async input(o: InputOptions) {
    this.log.push(`input:${o.title}:${o.value ?? ""}`);
    const v = this.inputs.shift();
    if (v !== undefined && o.validate?.(v)) {
      this.log.push(`invalid:${v}`);
      return undefined;
    }
    return v;
  }
  async confirm(message: string, detail: string) {
    this.log.push(`confirm:${message}|${detail}`);
    return this.confirms.shift() ?? true;
  }
  async approveCommand(title: string, origin: string) {
    this.log.push(`approve:${origin}:${title}`);
    return this.approve;
  }
  blocked(message: string) {
    this.log.push(`blocked:${message}`);
  }
  async withProgress<T>(_t: string, task: (token: CancellationTokenSource["token"]) => Promise<T>) {
    return task(new CancellationTokenSource().token);
  }
  info(m: string) {
    this.log.push(`info:${m}`);
  }
  error(m: string) {
    this.log.push(`error:${m}`);
  }
}

class FakeProcess extends ProcessRunner {
  runs: ProcessSpec[] = [];
  outcome: ProcessOutcome = { code: 0, cancelled: false, errorSummary: "" };
  async run(spec: ProcessSpec) {
    this.runs.push(spec);
    return this.outcome;
  }
  showOutput() {}
}
class FakeTerminal extends TerminalRunner {
  opened: (ProcessSpec & { name: string })[] = [];
  open(spec: ProcessSpec & { name: string }) {
    this.opened.push(spec);
  }
}
class FakeKubectl extends KubectlRunner {
  lines: string[] = [];
  async invoke(line: string) {
    this.lines.push(line);
    return { code: 0, stdout: "ok", stderr: "" };
  }
}
class FakeInvoker extends CommandInvoker {
  calls: [string, readonly unknown[]][] = [];
  async execute(id: string, args: readonly unknown[]) {
    this.calls.push([id, args]);
  }
}
class FakeWorkspace extends WorkspaceInfo {
  trusted = true;
  isTrusted() {
    return this.trusted;
  }
  folder() {
    return "/ws";
  }
  platform() {
    return "linux";
  }
  basePath() {
    return "/usr/bin";
  }
}

const engine = new ExpressionEngine("safe");
const def = (cfg: object, origin: ConfigOrigin = "builtin") =>
  compileCommand(CommandSchema.parse(cfg), origin, engine).command!;

let prompter: FakePrompter;
let proc: FakeProcess;
let terminal: FakeTerminal;
let kubectl: FakeKubectl;
let invoker: FakeInvoker;
let workspace: FakeWorkspace;
let settings: FakeSettings;
let state: FakeState;
let source: FakeResourceSource;
let contexts: ContextService;
let executor: CommandExecutor;
const batches = {
  run: vi.fn(async () => ({ succeeded: 2, failures: [] as string[], cancelled: false })),
} as BatchRunner;

const pod = res(
  kinds.pod,
  "web-1",
  { spec: { containers: [{ name: "app" }, { name: "sidecar" }], replicas: 2 } },
  "team-a",
);

beforeEach(async () => {
  vi.mocked(batches.run).mockClear();
  prompter = new FakePrompter();
  proc = new FakeProcess();
  terminal = new FakeTerminal();
  kubectl = new FakeKubectl();
  invoker = new FakeInvoker();
  workspace = new FakeWorkspace();
  settings = new FakeSettings();
  settings.values.extraPath = ["/opt/aws/bin"];
  state = new FakeState();
  source = new FakeResourceSource();
  contexts = new ContextService(
    new FakeKubeConfig(
      [
        { name: "dev", cluster: "dev-c", user: "dev-u", namespace: "team-a" },
        { name: "prod", cluster: "prod-c", user: "prod-u", namespace: "team-a" },
      ],
      "dev",
    ),
    state,
    settings,
    new FakeClusterApi(),
  );
  await contexts.initialize();
  executor = new CommandExecutor(
    contexts,
    settings,
    state,
    source,
    prompter,
    proc,
    terminal,
    kubectl,
    invoker,
    workspace,
    batches,
  );
  executor.now = () => new Date("2026-10-22T15:30:00Z");
});

describe("CommandExecutor", () => {
  test("process: renders argv, adds KUBECONFIG and extra PATH, refreshes after", async () => {
    const c = def({
      id: "restart",
      title: "Restart",
      refreshAfter: true,
      match: [{ kind: "Pod" }],
      run: {
        type: "process",
        command: "kubectl",
        args: ["delete", "pod", "${name}", "-n", "${namespace}", "--context", "${context}"],
        cwd: "${workspaceFolder}",
      },
    });
    expect(await executor.execute(c, [pod])).toBe("ok");
    expect(proc.runs).toEqual([
      {
        title: "Restart: web-1",
        command: "kubectl",
        args: ["delete", "pod", "web-1", "-n", "team-a", "--context", "dev"],
        cwd: "/ws",
        env: { KUBECONFIG: "/home/u/.kube/config", PATH: "/opt/aws/bin:/usr/bin" },
      },
    ]);
    expect(source.resynced).toBe(1);
  });

  test("pick input from JSONPath, auto-picked when only one option", async () => {
    const c = def({
      id: "logs",
      title: "Logs",
      match: [{ kind: "Pod" }],
      inputs: [{ id: "container", type: "pick", title: "Container", from: "$.spec.containers[*].name" }],
      run: {
        type: "terminal",
        name: "logs ${name}",
        command: "kubectl",
        args: ["logs", "${name}", "-c", "${input:container}"],
      },
    });
    prompter.picks = ["sidecar"];
    await executor.execute(c, [pod]);
    expect(prompter.log).toContain("pick:Container:app,sidecar");
    expect(terminal.opened[0]).toMatchObject({ name: "logs web-1", args: ["logs", "web-1", "-c", "sidecar"] });
    const single = res(kinds.pod, "one", { spec: { containers: [{ name: "only" }] } }, "team-a");
    await executor.execute(c, [single]);
    expect(terminal.opened[1]!.args).toEqual(["logs", "one", "-c", "only"]);
  });

  test("cancelled input aborts", async () => {
    const c = def({
      id: "scale",
      title: "Scale",
      match: [{ kind: "Pod" }],
      inputs: [{ id: "n", type: "prompt", title: "Replicas", default: "${$.spec.replicas}", pattern: "^\\d+$" }],
      run: { type: "process", command: "kubectl", args: ["scale", "--replicas=${input:n}"] },
    });
    prompter.inputs = [undefined];
    expect(await executor.execute(c, [pod])).toBe("cancelled");
    expect(prompter.log).toContain("input:Replicas:2");
    expect(proc.runs).toEqual([]);
  });

  test("dangerous commands are blocked by default and confirmed with the command line", async () => {
    const c = def({
      id: "del",
      title: "Delete",
      dangerous: true,
      match: [{ kind: "Pod" }],
      run: { type: "process", command: "kubectl", args: ["delete", "pod", "${name}", "--context", "${context}"] },
    });
    expect(await executor.execute(c, [pod])).toBe("blocked");
    expect(proc.runs).toEqual([]);
    settings.values.dangerous = "confirm";
    prompter.confirms = [false];
    expect(await executor.execute(c, [pod])).toBe("cancelled");
    expect(prompter.log.find((l) => l.startsWith("confirm:"))).toContain("kubectl delete pod web-1 --context dev");
    prompter.confirms = [true];
    expect(await executor.execute(c, [pod])).toBe("ok");
    expect(proc.runs).toHaveLength(1);
  });

  test("protected context always asks", async () => {
    settings.set({ protected: ["dev"] }, ["context.protected"]);
    const c = def({
      id: "get",
      title: "Get",
      match: [{ kind: "Pod" }],
      run: { type: "process", command: "kubectl", args: ["get", "pod"] },
    });
    prompter.confirms = [false];
    expect(await executor.execute(c, [pod])).toBe("cancelled");
    expect(prompter.log.some((l) => l.startsWith("confirm:") && l.includes("dev"))).toBe(true);
  });

  test("workspace commands need trust and a one-time approval per definition hash", async () => {
    const c = def(
      { id: "ws", title: "WS", match: [{ kind: "Pod" }], run: { type: "process", command: "make", args: [] } },
      "workspace",
    );
    workspace.trusted = false;
    expect(await executor.execute(c, [pod])).toBe("blocked");
    workspace.trusted = true;
    prompter.approve = false;
    expect(await executor.execute(c, [pod])).toBe("cancelled");
    prompter.approve = true;
    expect(await executor.execute(c, [pod])).toBe("ok");
    expect(await executor.execute(c, [pod])).toBe("ok");
    expect(prompter.log.filter((l) => l.startsWith("approve:"))).toHaveLength(2);
    const changed = def(
      { id: "ws", title: "WS", match: [{ kind: "Pod" }], run: { type: "process", command: "make", args: ["x"] } },
      "workspace",
    );
    await executor.execute(changed, [pod]);
    expect(prompter.log.filter((l) => l.startsWith("approve:"))).toHaveLength(3);
  });

  test("remote commands need a one-time approval and a rendered argv that matches the allowlist", async () => {
    const allowlist = CommandAllowlist.parse(["kubectl get *"]).allowlist;
    const remote = (args: string[]) =>
      compileCommand(
        CommandSchema.parse({ id: "r", title: "R", match: [{ kind: "Pod" }], run: { type: "kubectl", args } }),
        "remote",
        engine,
        allowlist,
      ).command!;
    prompter.approve = false;
    expect(await executor.execute(remote(["get", "${name}"]), [pod])).toBe("cancelled");
    expect(prompter.log).toContain("approve:remote:R");
    prompter.approve = true;
    expect(await executor.execute(remote(["get", "${name}"]), [pod])).toBe("ok");
    // Check the allowlist before automatically adding --context.
    expect(kubectl.lines).toEqual(["get web-1 --context dev"]);

    // Resource values must not become connection flags.
    const evil = res(kinds.pod, "--server=https://evil", {}, "team-a");
    expect(await executor.execute(remote(["get", "${name}"]), [evil])).toBe("blocked");
    expect(prompter.log.at(-1)).toContain("cannot be used");
    expect(kubectl.lines).toHaveLength(1);
  });

  test("kubectl type quotes arguments and adds --context", async () => {
    const c = def({
      id: "k",
      title: "K",
      match: [{ kind: "Pod" }],
      run: { type: "kubectl", args: ["annotate", "pod", "${name}", "note=hello world"] },
    });
    await executor.execute(c, [pod]);
    expect(kubectl.lines).toEqual(["annotate pod web-1 'note=hello world' --context dev"]);
  });

  test("kubectl type inserts --context before a -- separator", async () => {
    const c = def({
      id: "x",
      title: "X",
      match: [{ kind: "Pod" }],
      run: { type: "kubectl", args: ["exec", "${name}", "--", "ls", "--context", "x"] },
    });
    await executor.execute(c, [pod]);
    expect(kubectl.lines).toEqual(["exec web-1 --context dev -- ls --context x"]);
  });

  test("process cwd is not defaulted to the workspace folder", async () => {
    const c = def({
      id: "p",
      title: "P",
      match: [{ kind: "Pod" }],
      run: { type: "process", command: "kubectl", args: ["get", "pod"] },
    });
    await executor.execute(c, [pod]);
    expect(proc.runs[0]!.cwd).toBeUndefined();
  });

  test("run last applies the last command to the given targets, and is cleared on context change", async () => {
    const c = def({
      id: "echo",
      title: "Echo",
      match: [{ kind: "Pod" }],
      run: { type: "process", command: "echo", args: ["${name}"] },
    });
    await executor.execute(c, [pod]);
    const other = res(kinds.pod, "web-2", {}, "team-a");
    await executor.runLast([other]);
    expect(proc.runs.map((r) => r.args[0])).toEqual(["web-1", "web-2"]);
    await contexts.selectNamespace({ type: "all" });
    expect(executor.lastRun?.command.id).toBe("echo");
    await contexts.selectContext("prod");
    expect(executor.lastRun).toBeUndefined();
  });

  test("vscode type passes rendered args", async () => {
    const c = def({
      id: "m",
      title: "M",
      match: [{ kind: "Pod" }],
      run: { type: "vscode", command: "k8sView.openManifest", args: [{ name: "${name}" }] },
    });
    await executor.execute(c, [pod]);
    expect(invoker.calls).toEqual([["k8sView.openManifest", [{ name: "web-1" }]]]);
  });

  test("multi: none runs only for the first target; sequential runs all", async () => {
    const base = { title: "X", match: [{ kind: "Pod" }], run: { type: "process", command: "echo", args: ["${name}"] } };
    const other = res(kinds.pod, "web-2", {}, "team-a");
    await executor.execute(def({ id: "one", ...base }), [pod, other]);
    expect(proc.runs.map((r) => r.args[0])).toEqual(["web-1"]);
    await executor.execute(def({ id: "all", ...base, multi: "sequential" }), [pod, other]);
    expect(proc.runs.map((r) => r.args[0])).toEqual(["web-1", "web-1", "web-2"]);
  });

  test("failed process reports an error", async () => {
    proc.outcome = { code: 1, cancelled: false, errorSummary: "boom" };
    const c = def({
      id: "f",
      title: "Fail",
      match: [{ kind: "Pod" }],
      run: { type: "process", command: "false", args: [] },
    });
    expect(await executor.execute(c, [pod])).toBe("failed");
    expect(prompter.log.some((l) => l.startsWith("error:") && l.includes("boom"))).toBe(true);
  });

  test("snippet uses the selected namespace; timestamp variable; run last", async () => {
    const c = def({
      id: "snip",
      title: "Snip",
      target: "namespace",
      run: { type: "terminal", command: "kubectl", args: ["get", "all", "-n", "${namespace}", "${timestamp}"] },
    });
    await executor.execute(c, []);
    expect(terminal.opened[0]!.args).toEqual(["get", "all", "-n", "team-a", "20261022153000"]);
    expect(executor.lastRun?.command.id).toBe("snip");
    await executor.runLast();
    expect(terminal.opened).toHaveLength(2);
  });

  test("snippet params: fromKind lists names in the namespace; last values are offered again", async () => {
    source.addKind(kinds.deployment);
    source.set({ group: "apps", kind: "Deployment" }, "team-a", [
      res(kinds.deployment, "web", {}, "team-a"),
      res(kinds.deployment, "api", {}, "team-a"),
    ]);
    const c = def({
      id: "snip.logs",
      title: "Logs of",
      target: "namespace",
      inputs: [
        { id: "app", type: "pick", title: "App", fromKind: { group: "apps", kind: "Deployment" } },
        { id: "tail", type: "prompt", title: "Tail" },
        { id: "token", type: "prompt", title: "Token", secret: true },
      ],
      run: {
        type: "terminal",
        command: "kubectl",
        args: ["logs", "deploy/${input:app}", "--tail=${input:tail}", "-n", "${namespace}"],
      },
    });
    prompter.picks = ["web"];
    prompter.inputs = ["20", "t0k3n"];
    expect(await executor.execute(c, [])).toBe("ok");
    expect(prompter.log).toEqual(["pick:App:api,web", "input:Tail:", "input:Token:"]);
    expect(terminal.opened[0]!.args).toEqual(["logs", "deploy/web", "--tail=20", "-n", "team-a"]);
    expect(state.global.get("k8sView.inputHistory")).toEqual({ "snip.logs/app": "web", "snip.logs/tail": "20" });

    prompter.log = [];
    prompter.picks = ["web"];
    prompter.inputs = ["20", "x"];
    await executor.execute(c, []);
    // Previous selection first, prompt prefilled with the previous value; secret inputs are not remembered.
    expect(prompter.log).toEqual(["pick:App:web,api", "input:Tail:20", "input:Token:"]);
  });

  test("fromKind listing failure is reported and cancels", async () => {
    const c = def({
      id: "snip.x",
      title: "X",
      target: "namespace",
      inputs: [{ id: "cm", type: "pick", title: "CM", fromKind: { kind: "Missing" } }],
      run: { type: "terminal", command: "kubectl", args: ["get", "${input:cm}"] },
    });
    source.listNames = async () => {
      throw new Error("Missing is not served");
    };
    expect(await executor.execute(c, [])).toBe("cancelled");
    expect(prompter.log).toContain("error:X: cannot list Missing: Missing is not served");
  });

  test("secret input values are masked in the confirmation dialog", async () => {
    settings.values.dangerous = "confirm";
    const c = def({
      id: "snip.login",
      title: "Login",
      target: "context",
      dangerous: true,
      inputs: [{ id: "token", type: "prompt", title: "Token", secret: true }],
      run: { type: "process", command: "tool", args: ["login", "--token=${input:token}"] },
    });
    prompter.inputs = ["t0k3n"];
    await executor.execute(c, []);
    const confirm = prompter.log.find((l) => l.startsWith("confirm:"))!;
    expect(confirm).toContain("--token=••••");
    expect(confirm).not.toContain("t0k3n");
  });
});

describe("Batch commands", () => {
  const other = res(kinds.pod, "web-2", {}, "team-b");
  test("copy names writes the whole selection once, separated by newlines", async () => {
    const command = def({
      id: "copy",
      title: "Copy names",
      match: [{ group: "*", kind: "*" }],
      run: { type: "batch", operation: "copyNames" },
    });
    expect(await executor.execute(command, [pod, other])).toBe("ok");
    expect(invoker.calls).toEqual([["k8sView.copyToClipboard", ["web-1\nweb-2"]]]);
    expect(batches.run).not.toHaveBeenCalled();
  });
  test("asks input and confirmation once, then passes all targets to the batch runner", async () => {
    settings.values.dangerous = "confirm";
    prompter.inputs = ["3"];
    const targets = [res(kinds.deployment, "web", {}, "team-a"), res(kinds.deployment, "api", {}, "team-b")];
    const command = def({
      id: "scale",
      title: "Scale",
      dangerous: true,
      match: [{ group: "apps", kind: "Deployment" }],
      inputs: [{ id: "replicas", type: "prompt", title: "Replicas" }],
      run: { type: "batch", operation: "scale", replicas: "${input:replicas}" },
    });
    expect(await executor.execute(command, targets)).toBe("ok");
    expect(prompter.log.filter((l) => l.startsWith("input:"))).toHaveLength(1);
    expect(prompter.log.filter((l) => l.startsWith("confirm:"))).toHaveLength(1);
    expect(prompter.log.find((l) => l.startsWith("confirm:"))).toContain("Selected resources: 2");
    expect(batches.run).toHaveBeenCalledExactlyOnceWith(
      "dev",
      { type: "batch", operation: "scale", replicas: "3" },
      targets,
      expect.anything(),
    );
    expect(proc.runs).toHaveLength(0);
  });
  test("restricted and incompatible selections never reach the batch runner", async () => {
    const command = def({
      id: "delete",
      title: "Delete",
      dangerous: true,
      match: [{ kind: "Pod" }],
      run: { type: "batch", operation: "delete" },
    });
    expect(await executor.execute(command, [pod, other])).toBe("blocked");
    settings.values.dangerous = "confirm";
    expect(await executor.execute(command, [pod, res(kinds.deployment, "web")])).toBe("blocked");
    expect(batches.run).not.toHaveBeenCalled();
  });
  test("partial failures report the successful count and failing identity", async () => {
    vi.mocked(batches.run).mockResolvedValueOnce({
      succeeded: 1,
      failures: ["Pod team-b/web-2: forbidden"],
      cancelled: false,
    });
    settings.values.dangerous = "confirm";
    const command = def({
      id: "delete",
      title: "Delete",
      dangerous: true,
      match: [{ kind: "Pod" }],
      run: { type: "batch", operation: "delete" },
    });
    expect(await executor.execute(command, [pod, other])).toBe("failed");
    expect(prompter.log.at(-1)).toContain("1/2 succeeded. Pod team-b/web-2: forbidden");
  });
});
