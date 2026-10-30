import { beforeEach, describe, expect, test } from "vitest";
import type { AuthService } from "../../../src/app/AuthService";
import { InstanceService } from "../../../src/app/InstanceService";
import { InstanceSettingsStore } from "../../../src/app/InstanceSettingsStore";
import { Selection } from "../../../src/app/Selection";
import { InstanceTreeProvider } from "../../../src/ui/tree/InstanceTreeProvider";
import type { TreeNode } from "../../../src/ui/tree/TreeNode";
import { FakeAwsApi, instance, signedInAuth } from "../helpers/aws";
import { FakeSettings, FakeState } from "../helpers/fakes";

const NOW = Date.parse("2026-10-30T10:00:00Z");
let api: FakeAwsApi;
let auth: AuthService;
let store: InstanceSettingsStore;
let service: InstanceService;
let tree: InstanceTreeProvider;

beforeEach(async () => {
  api = new FakeAwsApi();
  const state = new FakeState();
  const settings = new FakeSettings();
  auth = await signedInAuth({ state, settings });
  store = new InstanceSettingsStore(state);
  service = new InstanceService(api, auth, new Selection(state, settings, auth), store);
  tree = new InstanceTreeProvider(service, store, () => NOW);
});

const item = (node: TreeNode | undefined) => tree.getTreeItem(node!);

describe("InstanceTreeProvider", () => {
  test("messages: loading, signed out, empty", async () => {
    expect(item(tree.getChildren()[0]).label).toBe("Loading instances…");
    await service.refresh();
    expect(item(tree.getChildren()[0])).toMatchObject({ label: "No instances match the filter" });
    await auth.signOut();
    expect(item(tree.getChildren()[0])).toMatchObject({
      label: "Sign in to dev",
      command: { command: "awsView.signIn" },
    });
  });

  test("instances: pinned first, description, icon and context value", async () => {
    api.instances = [
      instance({ id: "i-1", name: "api", state: "stopped" }),
      instance({ id: "i-2", name: "web", launchTime: NOW - 2 * 3_600_000, tags: { Name: "web", Owner: "me" } }),
    ];
    api.pings.set("i-2", "Online");
    await store.update("i-2", { pinned: true });
    await service.refresh();
    const [first, second] = tree.getChildren();
    expect(item(first)).toMatchObject({
      label: "web",
      id: "instance:i-2",
      description: "t3.large · running · SSM online",
      contextValue: "instance:remote:terminal:stop:pinned",
      iconPath: { id: "vm-running", color: { id: "testing.iconPassed" } },
    });
    const tooltip = item(first).tooltip as { value: string };
    expect(tooltip.value).toContain("Running for 2h 0m");
    expect(tooltip.value).toContain("`Owner` = me");
    expect(item(second)).toMatchObject({
      label: "api",
      description: "t3.large · stopped",
      contextValue: "instance:start:remote:unpinned",
      iconPath: { id: "vm-outline" },
    });
  });

  test("an AWS error is shown above the last list", async () => {
    api.instances = [instance({ id: "i-1" })];
    await service.refresh();
    api.failWith = new Error("Throttling");
    await service.refresh();
    const [error, node] = tree.getChildren();
    expect(item(error)).toMatchObject({ label: "Throttling", command: { command: "awsView.refresh" } });
    expect(node?.type).toBe("instance");
  });
});
