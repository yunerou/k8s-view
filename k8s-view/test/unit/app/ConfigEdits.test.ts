import { parse } from "jsonc-parser";
import { describe, expect, test } from "vitest";
import {
  appendCommand,
  columnsPatch,
  customViewText,
  removeCommand,
  snippetCommand,
  upsertSectionColumns,
  viewOverrideText,
} from "../../../src/app/ConfigEdits";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import type { SectionConfig } from "../../../src/core/config/schema";
import { CommandSchema, ViewSchema } from "../../../src/core/config/schema";
import { kinds } from "../helpers/fixtures";

const section: SectionConfig = ViewSchema.parse({
  id: "w",
  title: "W",
  sections: [
    {
      id: "pods",
      title: "Pods",
      resources: [{ kind: "Pod" }],
      columns: [
        { title: "Phase", path: "$.status.phase" },
        { title: "Node", path: "$.spec.nodeName", width: 100 },
        { title: "Age", path: "$.metadata.creationTimestamp", render: "age" },
      ],
    },
  ],
}).sections[0]!;

describe("columnsPatch", () => {
  test("only differences when order is unchanged", () => {
    expect(columnsPatch(section, { hidden: ["node"], widths: { phase: 80, node: 100 } }, "extends")).toEqual([
      { id: "phase", width: 80 },
      { id: "node", hidden: true },
    ]);
  });

  test("reorder in an extends patch removes then re-adds full definitions", () => {
    const out = columnsPatch(section, { columnOrder: ["name", "age", "phase", "node"], hidden: ["phase"] }, "extends");
    expect(out.slice(0, 3)).toEqual([
      { id: "phase", remove: true },
      { id: "node", remove: true },
      { id: "age", remove: true },
    ]);
    expect(out.slice(3).map((c) => (c as { id: string }).id)).toEqual(["age", "phase", "node"]);
    expect(out[4]).toMatchObject({ id: "phase", title: "Phase", path: "$.status.phase", hidden: true });
  });

  test("full view gets the complete column list", () => {
    const out = columnsPatch(section, { columnOrder: ["node", "phase", "age"] }, "full");
    expect(out.map((c) => (c as { id: string }).id)).toEqual(["node", "phase", "age"]);
    expect(out.every((c) => !("remove" in c))).toBe(true);
  });
});

describe("upsertSectionColumns", () => {
  const cols = [{ id: "node", hidden: true }];

  test("creates a new override file", () => {
    const text = upsertSectionColumns(undefined, "workload", "pods", cols);
    expect(parse(text)).toEqual({
      version: 1,
      views: [{ extends: "workload", sections: [{ id: "pods", columns: cols }] }],
    });
  });

  test("appends an override to a file without that view and keeps comments", () => {
    const text = upsertSectionColumns(`{\n  // mine\n  "version": 1,\n  "views": []\n}`, "workload", "pods", cols);
    expect(text).toContain("// mine");
    expect(parse(text).views).toEqual([{ extends: "workload", sections: [{ id: "pods", columns: cols }] }]);
  });

  test("replaces columns of an existing section entry", () => {
    const before = JSON.stringify({
      version: 1,
      views: [{ extends: "workload", title: "X", sections: [{ id: "pods", columns: [{ id: "age", remove: true }] }] }],
    });
    const after = parse(upsertSectionColumns(before, "workload", "pods", cols));
    expect(after.views[0]).toEqual({ extends: "workload", title: "X", sections: [{ id: "pods", columns: cols }] });
  });

  test("adds a section to an existing entry", () => {
    const before = JSON.stringify({
      version: 1,
      views: [{ id: "workload", title: "W", sections: [{ id: "other", title: "O", resources: [{ kind: "Pod" }] }] }],
    });
    const after = parse(upsertSectionColumns(before, "workload", "pods", cols));
    expect(after.views[0].sections[1]).toEqual({ id: "pods", columns: cols });
  });
});

test("viewOverrideText", () => {
  expect(parse(viewOverrideText("workload"))).toEqual({ version: 1, views: [{ extends: "workload" }] });
});

test("customViewText produces a valid view with one section per kind", () => {
  const text = customViewText("my-view", "My view", [kinds.deployment, kinds.kustomization]);
  const parsed = parseConfigText(text);
  expect(parsed.issues).toEqual([]);
  expect(parse(text).views[0].sections.map((s: { id: string }) => s.id)).toEqual(["deployments", "kustomizations"]);
  expect(parse(text).views[0].sections[1].resources).toEqual([
    { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
  ]);
});

describe("snippetCommand", () => {
  const base = {
    id: "snippet.pods",
    title: "Pods of app",
    commandLine: "kubectl get pods -l app=${input:app}",
    target: "namespace" as const,
    runIn: "terminal" as const,
    params: [{ id: "app", type: "resource" as const, group: "apps", kind: "Deployment" }],
    platform: "linux",
  };

  test("kubectl gets namespace and context flags; params become inputs; valid command", () => {
    const c = snippetCommand({ ...base, group: "Team" });
    expect(c).toEqual({
      id: "snippet.pods",
      title: "Pods of app",
      group: "Team",
      icon: "terminal",
      target: "namespace",
      inputs: [{ id: "app", type: "pick", title: "App", fromKind: { group: "apps", kind: "Deployment" } }],
      run: {
        type: "terminal",
        name: "Pods of app",
        command: "kubectl",
        args: [
          "get",
          "pods",
          "-l",
          "app=${input:app}",
          "-n",
          "${namespace|default:default}",
          "--context",
          "${context}",
        ],
      },
    });
    expect(CommandSchema.safeParse(c).success).toBe(true);
  });

  test("existing flags are kept; flags go before '--'; helm uses --kube-context", () => {
    const exec = snippetCommand({
      ...base,
      commandLine: "kubectl exec -n tools deploy/debug --context=prod -- sh -c ${input:cmd}",
      params: [{ id: "cmd", type: "text" }],
    });
    expect((exec["run"] as { args: string[] }).args).toEqual([
      "exec",
      "-n",
      "tools",
      "deploy/debug",
      "--context=prod",
      "--",
      "sh",
      "-c",
      "${input:cmd}",
    ]);
    const helm = snippetCommand({ ...base, commandLine: "helm list", target: "context", params: [] });
    expect((helm["run"] as { args: string[] }).args).toEqual(["list", "--kube-context", "${context}"]);
    expect(helm["inputs"]).toBeUndefined();
  });

  test("shell syntax runs through sh -c (PowerShell on Windows); options and secret params", () => {
    const c = snippetCommand({
      ...base,
      commandLine: "kubectl get pods | grep ${input:term}",
      runIn: "process",
      params: [
        { id: "term", type: "options", options: ["web", "api"] },
        { id: "token", type: "text", secret: true },
      ],
    });
    expect(c["run"]).toEqual({ type: "process", command: "sh", args: ["-c", "kubectl get pods | grep ${input:term}"] });
    expect(c["inputs"]).toEqual([
      { id: "term", type: "pick", title: "Term", options: ["web", "api"] },
      { id: "token", type: "prompt", title: "Token", secret: true },
    ]);
    const win = snippetCommand({ ...base, commandLine: "kubectl get pods | findstr web", platform: "win32" });
    expect((win["run"] as { command: string }).command).toBe("powershell.exe");
  });
});

describe("appendCommand / removeCommand", () => {
  test("new file, file without commands, file with comments", () => {
    const created = appendCommand(undefined, { id: "a" });
    expect(created.index).toBe(0);
    expect(JSON.parse(created.text)).toEqual({ version: 1, commands: [{ id: "a" }] });

    const noCommands = appendCommand('{ "version": 1, "views": [] }', { id: "a" });
    expect(parse(noCommands.text)).toEqual({ version: 1, views: [], commands: [{ id: "a" }] });

    const text = '{\n  // mine\n  "version": 1,\n  "commands": [{ "id": "a" }]\n}\n';
    const appended = appendCommand(text, { id: "b" });
    expect(appended.index).toBe(1);
    expect(appended.text).toContain("// mine");
    expect(parse(appended.text).commands).toEqual([{ id: "a" }, { id: "b" }]);

    const removed = removeCommand(appended.text, 0);
    expect(removed).toContain("// mine");
    expect(parse(removed).commands).toEqual([{ id: "b" }]);
  });
});
