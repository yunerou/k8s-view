import { describe, expect, test } from "vitest";
import { ContextService } from "../../../src/app/ContextService";
import { ViewRegistry } from "../../../src/app/ViewRegistry";
import { ViewSessionManager } from "../../../src/app/ViewSessionManager";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import { FakeResourceSource } from "../helpers/FakeResourceSource";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";
import { kinds } from "../helpers/fixtures";

const view = (id: string, title = id) => ({
  id,
  title,
  sections: [{ id: "pods", title: "Pods", resources: [{ kind: "Pod" }] }],
});

async function setup() {
  const settings = new FakeSettings();
  const contexts = new ContextService(
    new FakeKubeConfig([{ name: "dev", cluster: "dev", user: "u", namespace: "a" }], "dev"),
    new FakeState(),
    settings,
    new FakeClusterApi(),
  );
  await contexts.initialize();
  const source = new FakeResourceSource();
  source.addKind(kinds.pod);
  const registry = new ViewRegistry();
  const apply = (views: object[]) =>
    registry.apply(
      [{ id: "f", origin: "builtin", parsed: parseConfigText(JSON.stringify({ version: 1, views })) }],
      { trusted: true, isPresetActive: () => true },
      new Map(),
    );
  const manager = new ViewSessionManager(registry, contexts, source, settings);
  return { manager, apply, source };
}

describe("ViewSessionManager", () => {
  test("creates one session per view and keeps it across updates", async () => {
    const { manager, apply } = await setup();
    apply([view("a"), view("b")]);
    const a = manager.session("a")!;
    expect(manager.session("a")).toBe(a);
    apply([view("a", "A2")]);
    expect(manager.session("a")).toBe(a);
    expect(a.definition.title).toBe("A2");
    expect(manager.session("b")).toBeUndefined();
  });

  test("visibility is the union of tree and table", async () => {
    const { manager, apply } = await setup();
    apply([view("a")]);
    manager.setTreeVisible("a", true);
    manager.setTableVisible("a", true);
    manager.setTreeVisible("a", false);
    expect(manager.session("a")!.isVisible).toBe(true);
    manager.setTableVisible("a", false);
    expect(manager.session("a")!.isVisible).toBe(false);
  });
});
