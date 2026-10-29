import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileCommand } from "../../../src/core/command/CommandDefinition";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import type { CommandConfig, ViewConfig } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import { compileView } from "../../../src/core/view/ViewDefinition";
import { res } from "../helpers/fixtures";

const root = join(__dirname, "../../../resources");
const files = ["views", "commands", "presets"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f)),
);
const engine = new ExpressionEngine("safe");

describe("built-in and preset config files", () => {
  test("expected files exist", () => {
    expect(files.sort()).toEqual([
      "commands/batch.json",
      "commands/builtin.json",
      "presets/cert-manager.json",
      "presets/fluxcd.json",
      "views/config.json",
      "views/crd.json",
      "views/event.json",
      "views/gateway-api.json",
      "views/node.json",
      "views/scaling.json",
      "views/service.json",
      "views/serviceaccount.json",
      "views/volume.json",
      "views/workload.json",
    ]);
  });

  test.each(files)("%s passes the schema and compiles", (file) => {
    const parsed = parseConfigText(readFileSync(join(root, file), "utf8"));
    expect(parsed.issues).toEqual([]);
    for (const { config } of parsed.views) {
      expect("extends" in config).toBe(false);
      expect(compileView(config as ViewConfig, engine).issues).toEqual([]);
    }
    for (const { config } of parsed.commands) {
      expect("extends" in config).toBe(false);
      expect(compileCommand(config as CommandConfig, "builtin", engine).issues).toEqual([]);
    }
  });

  test("ids are unique across files", () => {
    const views: string[] = [];
    const commands: string[] = [];
    for (const file of files) {
      const parsed = parseConfigText(readFileSync(join(root, file), "utf8"));
      views.push(...parsed.views.map((v) => (v.config as ViewConfig).id));
      commands.push(...parsed.commands.map((c) => (c.config as CommandConfig).id));
    }
    expect(new Set(views).size).toBe(views.length);
    expect(new Set(commands).size).toBe(commands.length);
    expect(views).toEqual(
      expect.arrayContaining([
        "workload",
        "config",
        "volume",
        "service",
        "serviceaccount",
        "gateway-api",
        "scaling",
        "node",
        "event",
        "crd",
        "fluxcd",
        "cert-manager",
      ]),
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        "k8s.openInBrowser",
        "snippet.findPods",
        "snippet.containers",
        "flux.helmValues",
        "flux.helmDefaultValues",
      ]),
    );
  });

  test("CRD view shows storage/served/stored versions and flags pending storage migrations", () => {
    const parsed = parseConfigText(readFileSync(join(root, "views/crd.json"), "utf8"));
    const section = compileView(parsed.views[0]!.config as ViewConfig, engine).view.sections[0]!;
    const crdKind = new ResourceKind(
      "apiextensions.k8s.io",
      "v1",
      "CustomResourceDefinition",
      "customresourcedefinitions",
      false,
    );
    const crd = (versions: object[], storedVersions: string[]) =>
      res(crdKind, "certificates.cert-manager.io", {
        spec: {
          group: "cert-manager.io",
          names: { kind: "Certificate", plural: "certificates" },
          scope: "Namespaced",
          versions,
        },
        status: { storedVersions, conditions: [{ type: "Established", status: "True" }] },
      });
    const migrating = crd(
      [
        { name: "v1", served: true, storage: true },
        { name: "v1beta1", served: true, storage: false, deprecated: true },
        { name: "v1alpha2", served: false, storage: false },
      ],
      ["v1beta1", "v1"],
    );
    const cell = (id: string) => section.columns.find((c) => c.id === id)!.evaluate(migrating, Date.now()).text;
    expect(section.label(migrating)).toBe("Certificate");
    expect(section.groupKey(migrating)).toBe("cert-manager.io");
    expect(section.describe(migrating, Date.now())).toBe("v1 · served v1,v1beta1");
    expect(cell("storage-version")).toBe("v1");
    expect(cell("served-versions")).toBe("v1, v1beta1");
    expect(cell("deprecated")).toBe("v1beta1");
    expect(cell("stored-versions")).toBe("v1beta1, v1");
    expect(section.status(migrating)).toMatchObject({ level: "warning", summary: "Multiple stored versions" });

    const deprecated = crd(
      [
        { name: "v1", served: true, storage: true },
        { name: "v1beta1", served: true, storage: false, deprecated: true },
      ],
      ["v1"],
    );
    expect(section.status(deprecated)).toMatchObject({ level: "warning", summary: "Deprecated version served" });
    expect(section.status(crd([{ name: "v1", served: true, storage: true }], ["v1"])).level).toBe("ok");
  });

  test("built-in commands that change cluster state are dangerous", () => {
    const parsed = parseConfigText(readFileSync(join(root, "commands/builtin.json"), "utf8"));
    const byId = new Map(parsed.commands.map((c) => [(c.config as CommandConfig).id, c.config as CommandConfig]));
    for (const id of [
      "k8s.delete",
      "workload.scale",
      "workload.restart",
      "cronjob.suspend",
      "cronjob.resume",
      "node.cordon",
      "node.uncordon",
      "node.drain",
    ]) {
      expect(byId.get(id)?.dangerous, id).toBe(true);
    }
  });
});
