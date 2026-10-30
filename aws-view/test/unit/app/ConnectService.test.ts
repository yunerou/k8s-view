import { beforeEach, describe, expect, test } from "vitest";
import { ConnectService } from "../../../src/app/ConnectService";
import { Doctor } from "../../../src/app/Doctor";
import { InstanceService } from "../../../src/app/InstanceService";
import { InstanceSettingsStore } from "../../../src/app/InstanceSettingsStore";
import { Selection } from "../../../src/app/Selection";
import { renderHostBlock } from "../../../src/core/ssh/hostBlock";
import { cliScript, command, proxyCommand } from "../../../src/core/ssh/shell";
import { FakeAwsApi, instance, signedInAuth } from "../helpers/aws";
import {
  FakeNotifier,
  FakePrompter,
  FakeRunner,
  FakeSettings,
  FakeSshConfigStore,
  FakeState,
  FakeWorkbench,
} from "../helpers/fakes";

let api: FakeAwsApi;
let store: InstanceSettingsStore;
let ssh: FakeSshConfigStore;
let workbench: FakeWorkbench;
let runner: FakeRunner;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let connect: ConnectService;

const DEV_ENV = { AWS_PROFILE: "dev", AWS_REGION: "eu-west-1" };

beforeEach(async () => {
  api = new FakeAwsApi();
  const state = new FakeState();
  const settings = new FakeSettings();
  const auth = await signedInAuth({ state, settings });
  const selection = new Selection(state, settings, auth);
  store = new InstanceSettingsStore(state);
  ssh = new FakeSshConfigStore();
  workbench = new FakeWorkbench();
  runner = new FakeRunner();
  runner.handler = (cmd) =>
    cmd === "aws"
      ? { code: 0, stdout: "aws-cli/2.31.0 Python/3.13", stderr: "" }
      : { code: 0, stdout: "1.0", stderr: "" };
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  const instances = new InstanceService(api, auth, selection, store, async () => {});
  const doctor = new Doctor(runner, settings, workbench, prompter, notifier);
  connect = new ConnectService(
    instances,
    selection,
    auth,
    store,
    ssh,
    api,
    doctor,
    workbench,
    settings,
    prompter,
    notifier,
  );
});

describe("ConnectService.openRemote", () => {
  test("starts the instance, asks the SSH user (guessed from the AMI), writes the host and opens the window", async () => {
    const stopped = instance({ id: "i-0abc", name: "box", state: "stopped", imageId: "ami-ubuntu" });
    api.instances = [stopped];
    api.imageNames.set("ami-ubuntu", "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server");
    api.onDescribe = () => {
      if (!api.calls.includes("start i-0abc")) return;
      api.instances = [{ ...stopped, state: "running" }];
      api.pings.set("i-0abc", "Online");
    };
    prompter.answers.push("ubuntu", true);
    await connect.openRemote(stopped);

    expect(notifier.progressTitles).toEqual(["Preparing box…"]);
    expect(prompter.shown[0]).toMatchObject({ kind: "input", title: "SSH user for box", value: "ubuntu" });
    expect(prompter.shown[1]).toMatchObject({ kind: "confirm", title: "Add an Include line to ~/.ssh/config?" });
    expect(ssh.include).toBe(true);
    expect(ssh.hosts.get("aws-view-i-0abc")).toBe(
      renderHostBlock({
        instanceId: "i-0abc",
        label: "box",
        user: "ubuntu",
        identityFiles: ["/storage/id_ed25519"],
        knownHostsFile: "/storage/known_hosts",
        proxyCommand: proxyCommand({ awsPath: "aws", env: DEV_ENV, publicKeyPath: "/storage/id_ed25519.pub" }),
      }),
    );
    expect(store.get("i-0abc")).toEqual({ sshUser: "ubuntu", profile: "dev", region: "eu-west-1", name: "box" });
    expect(workbench.opened).toEqual([{ authority: "ssh-remote+aws-view-i-0abc", folderPath: "/home/ubuntu" }]);
  });

  test("the aws-view:ssh-user tag wins and the fallback key is added", async () => {
    ssh.include = true;
    await store.update("i-1", { fallbackKeyPath: "~/.ssh/my key.pem" });
    const box = instance({ id: "i-1", tags: { "aws-view:ssh-user": "dev" } });
    api.instances = [box];
    api.pings.set("i-1", "Online");
    await connect.openRemote(box);
    expect(prompter.shown).toEqual([]);
    expect(ssh.hosts.get("aws-view-i-1")).toContain('  IdentityFile "~/.ssh/my key.pem"\n');
    expect(workbench.opened[0]?.folderPath).toBe("/home/dev");
  });

  test("rejects an invalid SSH user tag before writing configuration", async () => {
    ssh.include = true;
    const box = instance({ id: "i-1", tags: { "aws-view:ssh-user": "root\nProxyCommand evil" } });
    api.instances = [box];
    api.pings.set("i-1", "Online");
    await connect.openRemote(box);
    expect(ssh.hosts.size).toBe(0);
    expect(workbench.opened).toEqual([]);
    expect(notifier.messages[0]?.message).toContain("valid Linux user name");
  });

  test("declining the Include line stops before writing or opening anything", async () => {
    await store.update("i-1", { sshUser: "ec2-user" });
    const box = instance({ id: "i-1" });
    api.instances = [box];
    api.pings.set("i-1", "Online");
    prompter.answers.push(false);
    await connect.openRemote(box);
    expect(ssh.hosts.size).toBe(0);
    expect(workbench.opened).toEqual([]);
  });

  test("a missing tool stops before any AWS call", async () => {
    runner.handler = (cmd) =>
      cmd === "session-manager-plugin"
        ? { code: null, stdout: "", stderr: "ENOENT" }
        : { code: 0, stdout: "aws-cli/2.31.0", stderr: "" };
    await connect.openRemote(instance({ id: "i-1" }));
    expect(notifier.messages[0]?.message).toBe(
      "Session Manager plugin is required: session-manager-plugin was not found.",
    );
    expect(api.calls).toEqual([]);
  });

  test("Cancel is silent, AWS errors are reported", async () => {
    notifier.cancelProgress = true;
    await connect.openRemote(instance({ id: "i-1" }));
    expect(notifier.messages).toEqual([]);
    notifier.cancelProgress = false;
    api.failWith = new Error("Request failed");
    await connect.openRemote(instance({ id: "i-1" }));
    expect(notifier.messages).toEqual([{ level: "error", message: "Request failed", actions: [] }]);
  });
});

describe("ConnectService: terminal and settings", () => {
  test("opens an SSM terminal as ssm-user, checking only the terminal tools", async () => {
    const box = instance({ id: "i-1", name: "box" });
    api.instances = [box];
    api.pings.set("i-1", "Online");
    await connect.openTerminal(box);
    expect(runner.calls.map((c) => c.command)).toEqual(["aws", "session-manager-plugin"]);
    expect(workbench.terminals).toEqual([
      {
        name: "SSM: box",
        shellPath: "/bin/sh",
        shellArgs: ["-c", cliScript(DEV_ENV, [command(["aws", "ssm", "start-session", "--target", "i-1"])])],
      },
    ]);
  });

  test("set SSH user and fallback key", async () => {
    const box = instance({ id: "i-1", name: "box" });
    prompter.answers.push("admin");
    await connect.setSshUser(box);
    expect(prompter.shown[0]?.value).toBe("ec2-user");
    expect(store.get("i-1").sshUser).toBe("admin");
    prompter.answers.push(" ~/.ssh/k.pem ", "");
    await connect.setFallbackKey(box);
    expect(store.get("i-1").fallbackKeyPath).toBe("~/.ssh/k.pem");
    await connect.setFallbackKey(box);
    expect(store.get("i-1").fallbackKeyPath).toBeUndefined();
    expect(notifier.messages.at(-1)?.message).toBe("Saved. Open box in Remote again to use it.");
  });
});
