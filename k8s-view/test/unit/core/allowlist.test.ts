import { describe, expect, test } from "vitest";
import { CommandAllowlist } from "../../../src/core/command/allowlist";
import type { RenderedRun } from "../../../src/core/command/CommandTemplate";
import { RunSchema } from "../../../src/core/config/schema";

const allow = (...patterns: string[]) => {
  const { allowlist, errors } = CommandAllowlist.parse(patterns);
  expect(errors).toEqual([]);
  return allowlist;
};
const run = (cfg: object) => RunSchema.parse(cfg);
const proc = (command: string, ...args: string[]): RenderedRun => ({ type: "process", command, args });

describe("CommandAllowlist.parse", () => {
  test.each([
    ["kubectl **", "first argument"],
    ["kubectl *", "first argument"],
    ["kubectl ge*", "first argument"],
    ["kubectl", "first argument"],
    ["kubectl -n prod **", "not a flag"],
    ["kube* get", "first argument"],
    ["sh -c **", "runs other programs"],
    ["/bin/bash script.sh", "runs other programs"],
    ["pwsh.exe Get-Item", "runs other programs"],
    ["env kubectl", "runs other programs"],
    ["kubectl get ** pods", "last token"],
    ["kubectl get pods**", "last token"],
    ["kubectl get ${input:x}", "templates"],
    ["vscode:k8sView.*", "without wildcards"],
    ["kubectl get 'pods", "Unterminated"],
  ])("rejects %s", (pattern, message) => {
    const { allowlist, errors } = CommandAllowlist.parse([pattern]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
    expect(allowlist.patterns).toHaveLength(0);
  });

  test("keeps the valid patterns next to invalid ones", () => {
    const { allowlist, errors } = CommandAllowlist.parse(["kubectl **", "kubectl get **", "vscode:k8sView.logs"]);
    expect(errors).toHaveLength(1);
    expect(allowlist.patterns.map((p) => p.source)).toEqual(["kubectl get **", "vscode:k8sView.logs"]);
  });
});

describe("CommandAllowlist matching", () => {
  test("empty allowlist blocks everything", () => {
    const empty = CommandAllowlist.empty;
    expect(empty.admit(run({ type: "kubectl", args: ["get", "pods"] }))).toContain("does not match");
    expect(empty.admit(run({ type: "vscode", command: "k8sView.logs" }))).toContain("not in allowCommands");
  });

  test("subcommand must match: kubectl get ** does not allow kubectl exec", () => {
    const a = allow("kubectl get **");
    expect(a.admit(run({ type: "kubectl", args: ["get", "pods", "-n", "${namespace}"] }))).toBeUndefined();
    expect(a.admit(run({ type: "terminal", command: "kubectl", args: ["get", "pods"] }))).toBeUndefined();
    expect(a.admit(run({ type: "kubectl", args: ["exec", "${name}", "--", "sh"] }))).toContain("does not match");
    expect(a.admit(run({ type: "process", command: "/tmp/kubectl", args: ["get"] }))).toContain("does not match");
  });

  test("a template cannot stand in for a literal token", () => {
    const a = allow("kubectl get **");
    expect(a.admit(run({ type: "kubectl", args: ["${input:verb}", "pods"] }))).toContain("does not match");
  });

  test("without ** the argument count is exact; * matches one argument; globs inside a token", () => {
    const a = allow("flux reconcile kustomization * --namespace=*");
    expect(a.check(proc("flux", "reconcile", "kustomization", "app", "--namespace=web"), "dev")).toBeUndefined();
    expect(a.check(proc("flux", "reconcile", "kustomization", "app"), "dev")).toContain("does not match");
    expect(a.check(proc("flux", "reconcile", "kustomization", "app", "--namespace=web", "x"), "dev")).toContain(
      "does not match",
    );
    expect(a.check(proc("flux", "reconcile", "kustomization", "app", "-n=web"), "dev")).toContain("does not match");
    // Template in a glob position: allow at load, validate again at execution.
    expect(
      a.admit(
        run({
          type: "process",
          command: "flux",
          args: ["reconcile", "kustomization", "${name}", "--namespace=${namespace}"],
        }),
      ),
    ).toBeUndefined();
  });

  test("cwd and env are refused", () => {
    const a = allow("kubectl get **");
    expect(a.admit(run({ type: "process", command: "kubectl", args: ["get"], env: { PATH: "/tmp" } }))).toContain(
      "env",
    );
    expect(a.admit(run({ type: "terminal", command: "kubectl", args: ["get"], cwd: "/tmp" }))).toContain("cwd");
    expect(a.check({ type: "process", command: "kubectl", args: ["get"], cwd: "/tmp" }, "dev")).toContain("cwd");
  });

  test("connection flags are refused even when the pattern allows them", () => {
    const a = allow("kubectl get **", "helm list **");
    for (const flag of ["--server=https://evil", "--kubeconfig", "--token=x", "--as=admin", "-s"]) {
      expect(a.admit(run({ type: "kubectl", args: ["get", "pods", flag] }))).toContain("cannot be used");
    }
    expect(a.check(proc("helm", "list", "--kube-apiserver", "https://evil"), "dev")).toContain("cannot be used");
    // After `--` is the in-container command.
    expect(a.check(proc("kubectl", "get", "pods", "--", "--token"), "dev")).toBeUndefined();
  });

  test("--context must be ${context} in the config and the running context at run time", () => {
    const a = allow("kubectl get **", "helm list **");
    expect(a.admit(run({ type: "kubectl", args: ["get", "--context", "${context}"] }))).toBeUndefined();
    expect(a.admit(run({ type: "kubectl", args: ["get", "--context=${context}"] }))).toBeUndefined();
    expect(a.admit(run({ type: "kubectl", args: ["get", "--context", "prod"] }))).toContain("${context}");
    expect(a.admit(run({ type: "kubectl", args: ["get", "--context=${input:ctx}"] }))).toContain("${context}");
    expect(a.check(proc("kubectl", "get", "--context", "dev"), "dev")).toBeUndefined();
    expect(a.check(proc("kubectl", "get", "--context=prod"), "dev")).toContain("${context}");
    expect(a.check(proc("helm", "list", "--kube-context", "prod"), "dev")).toContain("${context}");
  });

  test("rendered values are checked again at run time", () => {
    const a = allow("kubectl get *");
    // Resource value rendered as a connection flag.
    expect(a.check({ type: "kubectl", args: ["get", "--server=https://evil"] }, "dev")).toContain("cannot be used");
    expect(a.check({ type: "kubectl", args: ["get", "pods"] }, "dev")).toBeUndefined();
  });

  test("vscode commands need their exact id", () => {
    const a = allow("vscode:k8sView.logs");
    expect(a.admit(run({ type: "vscode", command: "k8sView.logs", args: [{ name: "${name}" }] }))).toBeUndefined();
    expect(a.check({ type: "vscode", command: "workbench.action.terminal.sendSequence", args: [] }, "dev")).toContain(
      "not in allowCommands",
    );
  });
});
