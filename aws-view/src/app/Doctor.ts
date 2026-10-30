import { inject, injectable } from "@needle-di/core";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import { Runner } from "./ports/Runner";
import { Settings } from "./ports/Settings";
import { Workbench } from "./ports/Workbench";

export type CheckId = "awsCli" | "sessionManagerPlugin" | "ssh" | "sshKeygen" | "remoteSsh";

export interface CheckResult {
  readonly id: CheckId;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export const TERMINAL_CHECKS: readonly CheckId[] = ["awsCli", "sessionManagerPlugin"];
export const REMOTE_CHECKS: readonly CheckId[] = ["awsCli", "sessionManagerPlugin", "ssh", "sshKeygen", "remoteSsh"];
export const REMOTE_SSH_EXTENSION = "ms-vscode-remote.remote-ssh";

const LABELS: Record<CheckId, string> = {
  awsCli: "AWS CLI v2",
  sessionManagerPlugin: "Session Manager plugin",
  ssh: "OpenSSH client",
  sshKeygen: "ssh-keygen",
  remoteSsh: "Remote - SSH extension",
};

const SSH_DOCS = "https://code.visualstudio.com/docs/remote/troubleshooting#_installing-a-supported-ssh-client";
const FIX_URLS: Record<CheckId, string> = {
  awsCli: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
  sessionManagerPlugin:
    "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html",
  ssh: SSH_DOCS,
  sshKeygen: SSH_DOCS,
  remoteSsh: "https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh",
};

/** Checks the local tools that SSM sessions and Remote - SSH need. */
@injectable()
export class Doctor {
  constructor(
    private readonly runner = inject(Runner),
    private readonly settings = inject(Settings),
    private readonly workbench = inject(Workbench),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
  ) {}

  check(ids: readonly CheckId[]): Promise<CheckResult[]> {
    return Promise.all(ids.map((id) => this.checkOne(id)));
  }

  /** Before an action: on failure, show the first problem with a fix and return `false`. */
  async ensure(ids: readonly CheckId[]): Promise<boolean> {
    const failed = (await this.check(ids)).find((r) => !r.ok);
    if (!failed) return true;
    const fix = failed.id === "remoteSsh" ? "Install" : "How to install";
    const action = await this.notifier.error(`${failed.label} is required: ${failed.detail}.`, fix, "Run Doctor");
    if (action === fix) await this.fix(failed.id);
    else if (action === "Run Doctor") await this.report();
    return false;
  }

  /** "Run Doctor": every check in a Quick Pick; picking a failed one opens its fix. */
  async report(): Promise<void> {
    const results = await this.check(REMOTE_CHECKS);
    const picked = await this.prompter.pick(
      results.map((r) => ({ label: `${r.ok ? "$(pass)" : "$(error)"} ${r.label}`, description: r.detail, value: r })),
      {
        title: "AWS View: Doctor",
        placeholder: results.every((r) => r.ok) ? "Everything is ready" : "Pick a failed check to fix it",
      },
    );
    if (picked && !picked.ok) await this.fix(picked.id);
  }

  private async fix(id: CheckId): Promise<void> {
    if (id === "remoteSsh") await this.workbench.installExtension(REMOTE_SSH_EXTENSION);
    else await this.workbench.openExternal(FIX_URLS[id]);
  }

  private async checkOne(id: CheckId): Promise<CheckResult> {
    const result = (ok: boolean, detail: string): CheckResult => ({ id, label: LABELS[id], ok, detail });
    switch (id) {
      case "awsCli": {
        const path = this.settings.awsCliPath();
        const r = await this.runner.run(path, ["--version"]);
        if (r.code === null) return result(false, `"${path}" was not found`);
        // v1 prints its version on stderr, v2 on stdout.
        const version = /aws-cli\/(\d+)\.\S*/.exec(`${r.stdout} ${r.stderr}`);
        if (!version) return result(false, (r.stderr || r.stdout).trim() || `exit code ${r.code}`);
        return Number(version[1]) >= 2
          ? result(true, version[0])
          : result(false, `${version[0]} found, version 2 is required`);
      }
      case "sessionManagerPlugin": {
        const r = await this.runner.run("session-manager-plugin", ["--version"]);
        return r.code === 0 ? result(true, r.stdout.trim()) : result(false, "session-manager-plugin was not found");
      }
      case "ssh": {
        const r = await this.runner.run("ssh", ["-V"]);
        return r.code === null ? result(false, "ssh was not found") : result(true, (r.stderr || r.stdout).trim());
      }
      case "sshKeygen": {
        // Prints its usage and exits 1: only "could not start" means missing.
        const r = await this.runner.run("ssh-keygen", ["-?"]);
        return r.code === null ? result(false, "ssh-keygen was not found") : result(true, "found");
      }
      case "remoteSsh":
        return this.workbench.hasExtension(REMOTE_SSH_EXTENSION)
          ? result(true, "installed")
          : result(false, "not installed");
    }
  }
}
