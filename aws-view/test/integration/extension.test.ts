import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Instance, SsmPing } from "../../src/core/ec2/model";
import type { TestApi } from "../../src/extension";

/** Commands that must be registered; later tasks add IDs here. */
const COMMANDS = [
  "awsView.runDoctor",
  "awsView.openRemote",
  "awsView.openTerminal",
  "awsView.setSshUser",
  "awsView.setFallbackKey",
  "awsView.rename",
  "awsView.editTags",
  "awsView.remoteActions",

  "awsView.selectProfile",
  "awsView.signIn",
  "awsView.signOut",
  "awsView.selectRegion",
  "awsView.refresh",
  "awsView.filter",
  "awsView.togglePinnedOnly",
  "awsView.clearFilter",
  "awsView.start",
  "awsView.stop",
  "awsView.pin",
  "awsView.unpin",
  "awsView.copyInstanceId",
];

const DEV_BOX: Instance = {
  id: "i-0abc",
  name: "dev box",
  type: "t3.large",
  state: "running",
  launchTime: Date.now() - 3_600_000,
  imageId: "ami-1",
  platform: "Linux/UNIX",
  tags: { Name: "dev box" },
  ssm: undefined,
};

describe("AWS View", () => {
  let api: TestApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<TestApi>("yunerou.aws-view");
    assert.ok(ext, "extension is installed");
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "test API is exposed (AWS_VIEW_INTEGRATION=1)");
    // No network in tests: every EC2/SSM call is stubbed.
    api.aws.describeInstances = async () => [DEV_BOX];
    api.aws.ssmPing = async () => new Map<string, SsmPing>([["i-0abc", "Online"]]);
    api.aws.startInstance = async () => {};
    api.aws.stopInstance = async () => {};
  });

  it("reads profiles from AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE", () => {
    assert.deepEqual(
      api.auth.profiles().map((p) => [p.name, p.kind]),
      [
        ["default", "static"],
        ["admin-role", "assumeRole"],
        ["corp-sso", "sso"],
        ["dev-mfa", "staticMfa"],
      ],
    );
  });

  it("signs in to a static profile and lists instances of its region", async () => {
    await api.auth.selectProfile("default");
    assert.equal(api.auth.state().status, "signedIn");
    await api.selection.clearFilter();
    await api.instances.refresh();
    const [node] = api.tree.getChildren();
    assert.equal(node?.type, "instance");
    const item = api.tree.getTreeItem(node!);
    assert.equal(item.label, "dev box");
    assert.equal(item.contextValue, "instance:remote:terminal:stop:unpinned");
  });

  it("pins an instance", async () => {
    await vscode.commands.executeCommand("awsView.pin", api.tree.getChildren()[0]);
    assert.equal(api.store.get("i-0abc").pinned, true);
    await vscode.commands.executeCommand("awsView.unpin", api.tree.getChildren()[0]);
  });

  it("registers every command", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of COMMANDS) assert.ok(all.includes(id), id);
  });
});
