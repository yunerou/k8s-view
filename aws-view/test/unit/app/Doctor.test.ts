import { beforeEach, describe, expect, test } from "vitest";
import { Doctor, REMOTE_CHECKS, TERMINAL_CHECKS } from "../../../src/app/Doctor";
import type { RunResult } from "../../../src/app/ports/Runner";
import { FakeNotifier, FakePrompter, FakeRunner, FakeSettings, FakeWorkbench } from "../helpers/fakes";

let runner: FakeRunner;
let workbench: FakeWorkbench;
let prompter: FakePrompter;
let notifier: FakeNotifier;
let doctor: Doctor;
let results: Record<string, RunResult>;

beforeEach(() => {
  results = {
    aws: { code: 0, stdout: "aws-cli/2.31.0 Python/3.13.7 Darwin/25.0.0 source/arm64\n", stderr: "" },
    "session-manager-plugin": { code: 0, stdout: "1.2.707.0\n", stderr: "" },
    ssh: { code: 0, stdout: "", stderr: "OpenSSH_9.9p2, LibreSSL 3.3.6\n" },
    "ssh-keygen": { code: 1, stdout: "", stderr: "usage: ssh-keygen …\n" },
  };
  runner = new FakeRunner();
  runner.handler = (command) => results[command] ?? { code: null, stdout: "", stderr: "ENOENT" };
  workbench = new FakeWorkbench();
  prompter = new FakePrompter();
  notifier = new FakeNotifier();
  doctor = new Doctor(runner, new FakeSettings(), workbench, prompter, notifier);
});

describe("Doctor", () => {
  test("everything installed", async () => {
    expect(await doctor.check(REMOTE_CHECKS)).toEqual([
      { id: "awsCli", label: "AWS CLI v2", ok: true, detail: "aws-cli/2.31.0" },
      { id: "sessionManagerPlugin", label: "Session Manager plugin", ok: true, detail: "1.2.707.0" },
      { id: "ssh", label: "OpenSSH client", ok: true, detail: "OpenSSH_9.9p2, LibreSSL 3.3.6" },
      { id: "sshKeygen", label: "ssh-keygen", ok: true, detail: "found" },
      { id: "remoteSsh", label: "Remote - SSH extension", ok: true, detail: "installed" },
    ]);
    expect(await doctor.ensure(TERMINAL_CHECKS)).toBe(true);
    expect(runner.calls.at(-1)).toMatchObject({ command: "session-manager-plugin" });
  });

  test("AWS CLI v1 and a missing plugin are failures", async () => {
    results["aws"] = { code: 0, stdout: "", stderr: "aws-cli/1.29.0 Python/3.9\n" };
    results["session-manager-plugin"] = { code: null, stdout: "", stderr: "ENOENT" };
    const [aws, plugin] = await doctor.check(TERMINAL_CHECKS);
    expect(aws).toMatchObject({ ok: false, detail: "aws-cli/1.29.0 found, version 2 is required" });
    expect(plugin).toMatchObject({ ok: false, detail: "session-manager-plugin was not found" });
  });

  test("ensure shows the first problem and opens its fix", async () => {
    results["session-manager-plugin"] = { code: null, stdout: "", stderr: "ENOENT" };
    notifier.reply = "How to install";
    expect(await doctor.ensure(REMOTE_CHECKS)).toBe(false);
    expect(notifier.messages).toEqual([
      {
        level: "error",
        message: "Session Manager plugin is required: session-manager-plugin was not found.",
        actions: ["How to install", "Run Doctor"],
      },
    ]);
    expect(workbench.urls).toEqual([
      "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html",
    ]);
  });

  test("a missing Remote - SSH extension can be installed from the report", async () => {
    workbench.extensions.clear();
    prompter.answers.push({ id: "remoteSsh", label: "Remote - SSH extension", ok: false, detail: "not installed" });
    await doctor.report();
    expect(prompter.shown[0]?.items?.map((i) => i.label)).toEqual([
      "$(pass) AWS CLI v2",
      "$(pass) Session Manager plugin",
      "$(pass) OpenSSH client",
      "$(pass) ssh-keygen",
      "$(error) Remote - SSH extension",
    ]);
    expect(workbench.installed).toEqual(["ms-vscode-remote.remote-ssh"]);
  });
});
