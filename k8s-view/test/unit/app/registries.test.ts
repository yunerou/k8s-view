import { describe, expect, test } from "vitest";
import { EventEmitter } from "vscode";
import { CommandRegistry } from "../../../src/app/CommandRegistry";
import { ConfigService } from "../../../src/app/ConfigService";
import { HotkeyService } from "../../../src/app/HotkeyService";
import { KindViewService } from "../../../src/app/KindViewService";
import { type ConfigLocatedIssue, ConfigSource, type LoadedConfigFile } from "../../../src/app/ports/ConfigSource";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import { CommandAllowlist } from "../../../src/core/command/allowlist";
import type { ConfigOrigin } from "../../../src/core/config/origin";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import { FakeSettings, FakeState } from "../helpers/fakes";
import { kinds, res } from "../helpers/fixtures";

class FakeConfigSource extends ConfigSource {
  readonly changed = new EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  files: LoadedConfigFile[] = [];
  reported = new Map<string, readonly ConfigLocatedIssue[]>();
  trusted = true;
  add(id: string, origin: ConfigOrigin, json: object, preset?: string) {
    this.files.push({
      id,
      origin,
      parsed: parseConfigText(JSON.stringify({ version: 1, ...json })),
      ...(preset ? { preset } : {}),
    });
  }
  addRemote(id: string, json: object, allowCommands: string[]) {
    this.files.push({
      id,
      origin: "remote",
      parsed: parseConfigText(JSON.stringify({ version: 1, ...json })),
      allowlist: CommandAllowlist.parse(allowCommands).allowlist,
    });
  }
  async load() {
    return this.files;
  }
  report(issues: ReadonlyMap<string, readonly ConfigLocatedIssue[]>) {
    this.reported = new Map(issues);
  }
  isWorkspaceTrusted() {
    return this.trusted;
  }
}

const podsView = (id: string, title = id, extra: object = {}) => ({
  id,
  title,
  sections: [
    { id: "pods", title: "Pods", resources: [{ kind: "Pod" }], columns: [{ title: "Phase", path: "$.status.phase" }] },
  ],
  ...extra,
});

function setup() {
  const source = new FakeConfigSource();
  const settings = new FakeSettings();
  const views = new ViewRegistry();
  const commands = new CommandRegistry();
  const hotkeys = new HotkeyService(new FakeState(), settings, views);
  const service = new ConfigService(source, settings, views, commands, hotkeys);
  return { source, settings, views, commands, hotkeys, service };
}

describe("HotkeyService via ConfigService", () => {
  test("reload applies the hotkeys of the loaded files", async () => {
    const { source, service, hotkeys } = setup();
    source.add("file:///user/keys.json", "user", { hotkeys: { bindings: [{ key: "g", action: "refresh" }] } });
    await service.reload();
    expect(hotkeys.state().bindings.find((b) => b.label === "g")?.action).toEqual({ action: "refresh" });
  });

  test("favorites resolve to view titles and follow the setting", async () => {
    const { source, service, hotkeys, settings } = setup();
    source.add("builtin://workload", "builtin", { views: [podsView("workload", "Workload")] });
    await service.reload();
    let fired = 0;
    hotkeys.onDidChange(() => fired++);
    settings.set({ favoriteViews: ["", "workload", "gone"] }, ["views.favorites"]);
    expect(fired).toBe(1);
    expect(hotkeys.state().favorites).toEqual(["", "Workload", "gone"]);
    settings.set({ tailLines: 10 }, ["logs.tailLines"]);
    expect(fired).toBe(1);
  });
});

describe("ViewRegistry via ConfigService", () => {
  test("later sources replace views with the same id; order by `order` then title", async () => {
    const { source, service, views } = setup();
    source.add("builtin://workload", "builtin", {
      views: [podsView("workload", "Workload", { order: 1 }), podsView("config", "Config", { order: 3 })],
    });
    source.add("file:///user/a.json", "user", {
      views: [podsView("workload", "Mine", { order: 1 }), podsView("extra", "Extra")],
    });
    await service.reload();
    expect(views.views().map((v) => `${v.id}:${v.title}`)).toEqual(["workload:Mine", "config:Config", "extra:Extra"]);
    expect(views.get("workload")?.origin).toBe("user");
  });

  test("extends merges onto the previously loaded view and reports unknown targets", async () => {
    const { source, service, views } = setup();
    source.add("builtin://w", "builtin", { views: [podsView("workload", "Workload")] });
    source.add("file:///ws/.vscode/k8s-view/a.json", "workspace", {
      views: [
        {
          extends: "workload",
          title: "Team workload",
          sections: [{ id: "pods", columns: [{ title: "Node", path: "$.spec.nodeName" }] }],
        },
        { extends: "missing", title: "x" },
      ],
    });
    await service.reload();
    const v = views.get("workload")!;
    expect(v.definition.title).toBe("Team workload");
    expect(v.definition.sections[0]!.columns.map((c) => c.id)).toEqual(["phase", "node"]);
    expect(source.reported.get("file:///ws/.vscode/k8s-view/a.json")).toEqual([
      {
        path: ["views", 1, "extends"],
        message: "Unknown view 'missing' (extends must point to a view loaded earlier)",
        severity: "error",
      },
    ]);
  });

  test("invalid merge result is reported on the patch and the base stays", async () => {
    const { source, service, views } = setup();
    source.add("builtin://w", "builtin", { views: [podsView("workload")] });
    source.add("file:///u.json", "user", { views: [{ extends: "workload", sections: [{ id: "new-section" }] }] });
    await service.reload();
    expect(views.get("workload")?.origin).toBe("builtin");
    expect(source.reported.get("file:///u.json")?.[0]?.path).toEqual(["views", 0]);
  });

  test("compile errors are reported with file paths; untrusted workspace disables filters", async () => {
    const { source, service, views } = setup();
    source.trusted = false;
    source.add("file:///ws/a.json", "workspace", {
      views: [
        {
          ...podsView("ws"),
          sections: [
            {
              id: "s",
              title: "S",
              resources: [{ kind: "Pod" }],
              columns: [{ title: "Ready", path: "$.c[?(@.t=='x')]" }],
            },
          ],
        },
      ],
    });
    await service.reload();
    expect(views.get("ws")!.definition.sections[0]!.columns).toEqual([]);
    expect(source.reported.get("file:///ws/a.json")?.[0]).toMatchObject({
      path: ["views", 0, "sections", 0, "columns", 0, "path"],
    });
  });

  test("preset views are active when enabled or auto-enable is on", async () => {
    const { source, service, views, settings } = setup();
    source.add(
      "builtin://presets/fluxcd.json",
      "preset",
      { views: [podsView("fluxcd", "FluxCD", { requires: ["kustomize.toolkit.fluxcd.io"] })] },
      "fluxcd",
    );
    settings.values.autoEnable = false;
    await service.reload();
    expect(views.views().map((v) => v.id)).toEqual([]);
    settings.set({ presets: ["fluxcd"] }, ["presets.enabled"]);
    await service.whenIdle();
    expect(views.views().map((v) => v.id)).toEqual(["fluxcd"]);
  });

  test("disabled views are hidden", async () => {
    const { source, service, views } = setup();
    source.add("builtin://w", "builtin", { views: [podsView("workload")] });
    source.add("file:///u.json", "user", { views: [{ extends: "workload", enabled: false }] });
    await service.reload();
    expect(views.views()).toEqual([]);
  });

  test("fires onDidChange after reload", async () => {
    const { source, service, views } = setup();
    let fired = 0;
    views.onDidChange(() => fired++);
    source.add("builtin://w", "builtin", { views: [podsView("workload")] });
    source.changed.fire();
    await service.whenIdle();
    expect(fired).toBe(1);
  });
});

describe("CommandRegistry via ConfigService", () => {
  const cmd = (id: string, extra: object = {}) => ({
    id,
    title: id,
    match: [{ kind: "Pod" }],
    run: { type: "kubectl", args: ["get", "pod", "${name}"] },
    ...extra,
  });

  test("filters by resource, sorts by group/order/title and exposes snippets", async () => {
    const { source, service, commands } = setup();
    source.add("builtin://c", "builtin", {
      commands: [
        cmd("b", { group: "Pod", order: 2 }),
        cmd("a", { group: "Pod", order: 1 }),
        cmd("z", { group: "General" }),
        cmd("svc", { match: [{ kind: "Service" }] }),
        { id: "snip", title: "Snippet", target: "context", run: { type: "terminal", command: "flux", args: [] } },
      ],
    });
    await service.reload();
    expect(commands.forResource(res(kinds.pod, "p")).map((c) => c.id)).toEqual(["z", "a", "b"]);
    expect(commands.snippets().map((c) => c.id)).toEqual(["snip"]);
    expect(commands.locationOf("snip")).toEqual({ fileId: "builtin://c", index: 4, origin: "builtin" });
    expect(commands.locationOf("nope")).toBeUndefined();
  });

  test("workspace commands are not loaded in untrusted workspaces", async () => {
    const { source, service, commands } = setup();
    source.trusted = false;
    source.add("file:///ws/c.json", "workspace", { commands: [cmd("ws")] });
    await service.reload();
    expect(commands.get("ws")).toBeUndefined();
  });

  test("extends override keeps id and takes the overriding origin", async () => {
    const { source, service, commands } = setup();
    source.add("builtin://c", "builtin", { commands: [cmd("k8s.delete", { dangerous: true })] });
    source.add("file:///u.json", "user", { commands: [{ extends: "k8s.delete", skipConfirm: true }] });
    await service.reload();
    const c = commands.get("k8s.delete")!;
    expect(c.origin).toBe("user");
    expect(c.dangerous).toBe(true);
    expect(c.skipConfirm).toBe(true);
  });

  test("workspace overrides cannot lower dangerous or drop confirm of other sources", async () => {
    const { source, service, commands } = setup();
    source.add("builtin://c", "builtin", {
      commands: [cmd("k8s.delete", { dangerous: true, confirm: "Delete ${name}?" })],
    });
    source.add("file:///ws/.vscode/k8s-view/a.json", "workspace", {
      commands: [{ extends: "k8s.delete", dangerous: false, confirm: "", title: "Delete (team)" }],
    });
    await service.reload();
    const c = commands.get("k8s.delete")!;
    expect(c.title).toBe("Delete (team)");
    expect(c.dangerous).toBe(true);
    expect(c.config.confirm).toBe("Delete ${name}?");
    expect(source.reported.get("file:///ws/.vscode/k8s-view/a.json")?.[0]).toMatchObject({ severity: "warning" });
  });

  test("user overrides may lower dangerous", async () => {
    const { source, service, commands } = setup();
    source.add("builtin://c", "builtin", { commands: [cmd("k8s.delete", { dangerous: true })] });
    source.add("file:///u.json", "user", { commands: [{ extends: "k8s.delete", dangerous: false }] });
    await service.reload();
    expect(commands.get("k8s.delete")!.dangerous).toBe(false);
  });

  test("remote commands load only when their run matches allowCommands", async () => {
    const { source, service, commands } = setup();
    source.addRemote(
      "file:///cache/a.json",
      {
        commands: [
          cmd("r.get"),
          cmd("r.exec", { run: { type: "kubectl", args: ["exec", "${name}", "--", "sh"] } }),
          cmd("r.env", { run: { type: "process", command: "kubectl", args: ["get"], env: { PATH: "/tmp" } } }),
        ],
      },
      ["kubectl get **"],
    );
    source.addRemote("file:///cache/b.json", { commands: [cmd("r.none")] }, []);
    await service.reload();
    expect(commands.get("r.get")?.origin).toBe("remote");
    expect(commands.get("r.get")?.allowlist).toBeDefined();
    expect(commands.get("r.exec")).toBeUndefined();
    expect(commands.get("r.env")).toBeUndefined();
    expect(commands.get("r.none")).toBeUndefined();
    expect(source.reported.get("file:///cache/a.json")?.map((i) => i.path)).toEqual([
      ["commands", 1, "run"],
      ["commands", 2, "run"],
    ]);
    expect(source.reported.get("file:///cache/b.json")?.[0]?.message).toContain("blocked");
  });

  test("a blocked remote override leaves the earlier command in place; allowed ones cannot weaken it", async () => {
    const { source, service, commands } = setup();
    source.add("builtin://c", "builtin", {
      commands: [
        cmd("k8s.delete", { dangerous: true, confirm: "Delete?", run: { type: "kubectl", args: ["delete"] } }),
        cmd("k8s.get", { dangerous: true, confirm: "Get?" }),
      ],
    });
    source.addRemote(
      "file:///cache/a.json",
      {
        commands: [
          { extends: "k8s.delete", title: "Delete (remote)" },
          { extends: "k8s.get", run: { type: "process", command: "rm", args: ["-rf", "/"] } },
          { extends: "k8s.get", dangerous: false, confirm: "", title: "Get (remote)" },
        ],
      },
      ["kubectl get **"],
    );
    await service.reload();
    expect(commands.get("k8s.delete")?.title).toBe("k8s.delete");
    expect(commands.get("k8s.delete")?.origin).toBe("builtin");
    const get = commands.get("k8s.get")!;
    expect(get.title).toBe("Get (remote)");
    expect(get.origin).toBe("remote");
    expect(get.config.run).toEqual({ type: "kubectl", args: ["get", "pod", "${name}"] });
    expect(get.dangerous).toBe(true);
    expect(get.config.confirm).toBe("Get?");
    expect(source.reported.get("file:///cache/a.json")?.map((i) => i.severity)).toEqual([
      "warning",
      "warning",
      "warning",
    ]);
  });

  test("local overrides keep the remote allowlist unless they replace run", async () => {
    const { source, service, commands } = setup();
    source.addRemote("file:///cache/a.json", { commands: [cmd("r.get")] }, ["kubectl get **"]);
    source.add("file:///u.json", "user", {
      commands: [
        { extends: "r.get", id: "r.get2", title: "Mine" },
        { extends: "r.get", id: "r.own", run: { type: "kubectl", args: ["describe", "pod", "${name}"] } },
      ],
    });
    await service.reload();
    expect(commands.get("r.get2")?.origin).toBe("user");
    expect(commands.get("r.get2")?.allowlist).toBeDefined();
    expect(commands.get("r.own")?.allowlist).toBeUndefined();
  });

  test("preset commands follow preset enablement", async () => {
    const { source, service, commands, settings } = setup();
    settings.values.autoEnable = false;
    source.add("builtin://presets/fluxcd.json", "preset", { commands: [cmd("flux.reconcile")] }, "fluxcd");
    await service.reload();
    expect(commands.get("flux.reconcile")).toBeUndefined();
  });
});

describe("hidden and dynamic views", () => {
  test("k8sView.views.hidden removes views from the list without reloading files", async () => {
    const { source, service, views, settings } = setup();
    source.add("builtin://v", "builtin", { views: [podsView("workload", "Workload"), podsView("node", "Node")] });
    settings.values.hiddenViews = ["node"];
    await service.reload();
    expect(views.views().map((v) => v.id)).toEqual(["workload"]);
    expect(views.allViews().map((v) => v.id)).toEqual(["node", "workload"]);
    expect(views.isHidden("node")).toBe(true);
    let changes = 0;
    views.onDidChange(() => changes++);
    await settings.setHiddenViews([]);
    expect(views.views().map((v) => v.id)).toEqual(["node", "workload"]);
    expect(changes).toBe(1);
  });

  test("the Single resource kind view is remembered, survives reloads, and a file view with its id wins", async () => {
    const { source, service, views } = setup();
    const state = new FakeState();
    const kindView = new KindViewService(views, state);
    await service.reload();
    kindView.restore();
    expect(views.get("kind")).toBeUndefined();

    await kindView.select({ group: "cert-manager.io", kind: "Certificate", plural: "certificates" });
    expect(views.get("kind")?.title).toBe("Kind: Certificate");
    expect(views.get("kind")?.dynamic).toBe(true);
    await service.reload();
    expect(views.get("kind")?.definition.sections[0]?.resources).toEqual([
      { group: "cert-manager.io", kind: "Certificate" },
    ]);

    const other = new ViewRegistry();
    new KindViewService(other, state).restore();
    expect(other.get("kind")?.title).toBe("Kind: Certificate");

    source.add("file:///u.json", "user", { views: [podsView("kind", "My kind view")] });
    await service.reload();
    expect(views.get("kind")?.title).toBe("My kind view");
  });
});
