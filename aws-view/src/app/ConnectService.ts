import { inject, injectable } from "@needle-di/core";
import { awsErrorMessage } from "../core/aws/errors";
import { guessSshUser, type Instance, instanceLabel, SSH_USER_TAG, sshUserTag } from "../core/ec2/model";
import { homeDir, remoteAuthority, renderHostBlock, sshAlias } from "../core/ssh/hostBlock";
import { cliScript, command, proxyCommand } from "../core/ssh/shell";
import { isCanceled } from "../core/util/errors";
import { AuthService } from "./AuthService";
import { Doctor, REMOTE_CHECKS, TERMINAL_CHECKS } from "./Doctor";
import { InstanceService } from "./InstanceService";
import { InstanceSettingsStore } from "./InstanceSettingsStore";
import { AwsApi, type AwsTarget } from "./ports/AwsApi";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import { Settings } from "./ports/Settings";
import { SshConfigStore } from "./ports/SshConfigStore";
import { Workbench } from "./ports/Workbench";
import { Selection } from "./Selection";

const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;

/** Open an instance in Remote - SSH or in an SSM terminal, starting it first when needed. */
@injectable()
export class ConnectService {
  constructor(
    private readonly instances = inject(InstanceService),
    private readonly selection = inject(Selection),
    private readonly auth = inject(AuthService),
    private readonly store = inject(InstanceSettingsStore),
    private readonly ssh = inject(SshConfigStore),
    private readonly api = inject(AwsApi),
    private readonly doctor = inject(Doctor),
    private readonly workbench = inject(Workbench),
    private readonly settings = inject(Settings),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
  ) {}

  async openRemote(instance: Instance): Promise<void> {
    await this.report(async () => {
      if (!(await this.doctor.ensure(REMOTE_CHECKS))) return;
      const { target, ready } = await this.prepare(instance);
      const user = await this.sshUser(ready, target);
      if (!user || !(await this.ensureInclude())) return;
      const key = await this.ssh.ensureKeyPair();
      const fallback = this.store.get(ready.id).fallbackKeyPath;
      const block = renderHostBlock({
        instanceId: ready.id,
        label: instanceLabel(ready),
        user,
        identityFiles: fallback ? [key.privateKey, fallback] : [key.privateKey],
        knownHostsFile: this.ssh.knownHostsFile,
        proxyCommand: proxyCommand({
          awsPath: this.settings.awsCliPath(),
          env: this.auth.cliEnv(target.region),
          publicKeyPath: key.publicKey,
        }),
      });
      await this.ssh.upsertHost(sshAlias(ready.id), block);
      await this.store.update(ready.id, { profile: target.profile, region: target.region, name: instanceLabel(ready) });
      await this.workbench.openRemoteWindow(remoteAuthority(ready.id), homeDir(user));
    });
  }

  /** Interactive shell as `ssm-user` (no SSH key involved). */
  async openTerminal(instance: Instance): Promise<void> {
    await this.report(async () => {
      if (!(await this.doctor.ensure(TERMINAL_CHECKS))) return;
      const { target, ready } = await this.prepare(instance);
      const start = command([this.settings.awsCliPath(), "ssm", "start-session", "--target", ready.id]);
      const script = cliScript(this.auth.cliEnv(target.region), [start]);
      this.workbench.openTerminal(`SSM: ${instanceLabel(ready)}`, "/bin/sh", ["-c", script]);
    });
  }

  async setSshUser(i: Instance): Promise<void> {
    await this.askSshUser(i, sshUserTag(i) ?? this.store.get(i.id).sshUser ?? "ec2-user");
  }

  async setFallbackKey(i: Instance): Promise<void> {
    const value = await this.prompter.input({
      title: `Fallback SSH key for ${instanceLabel(i)}`,
      prompt: "Private key used when EC2 Instance Connect is not available. Leave empty to remove it.",
      value: this.store.get(i.id).fallbackKeyPath ?? "",
      placeholder: "~/.ssh/my-key.pem",
      validate: (v) => (/[\r\n\0]/.test(v) ? "Enter a private key path on one line" : undefined),
    });
    if (value === undefined) return;
    if (value.trim()) await this.store.update(i.id, { fallbackKeyPath: value.trim() });
    else await this.store.unset(i.id, "fallbackKeyPath");
    await this.notifier.info(`Saved. Open ${instanceLabel(i)} in Remote again to use it.`);
  }

  /** Signed in, then the instance running with its SSM agent online (started if needed). */
  private async prepare(instance: Instance): Promise<{ target: AwsTarget; ready: Instance }> {
    const target = this.selection.target();
    if (!target) throw new Error("Select an AWS profile and a region first.");
    await this.auth.credentials();
    const ready = await this.notifier.progress(`Preparing ${instanceLabel(instance)}…`, (signal) =>
      this.instances.ensureOnline(instance.id, signal),
    );
    return { target, ready };
  }

  private async sshUser(i: Instance, target: AwsTarget): Promise<string | undefined> {
    const tagged = sshUserTag(i);
    if (tagged) {
      if (!USER_RE.test(tagged)) throw new Error(`The tag ${SSH_USER_TAG} must contain a valid Linux user name.`);
      return tagged;
    }
    const saved = this.store.get(i.id).sshUser;
    if (saved) return saved;
    const imageName = i.imageId ? await this.api.imageName(target, i.imageId) : undefined;
    return this.askSshUser(i, guessSshUser(imageName));
  }

  private async askSshUser(i: Instance, suggestion: string): Promise<string | undefined> {
    const user = await this.prompter.input({
      title: `SSH user for ${instanceLabel(i)}`,
      prompt: `Linux user to log in as. The tag ${SSH_USER_TAG} on the instance overrides this.`,
      value: suggestion,
      validate: (v) => (USER_RE.test(v.trim()) ? undefined : "Enter a Linux user name such as ec2-user"),
    });
    if (user === undefined) return undefined;
    await this.store.update(i.id, { sshUser: user.trim() });
    return user.trim();
  }

  private async ensureInclude(): Promise<boolean> {
    if (await this.ssh.hasInclude()) return true;
    const ok = await this.prompter.confirm(
      "Add an Include line to ~/.ssh/config?",
      `AWS View writes its hosts to ${this.settings.sshConfigPath()}. Remote - SSH only sees them when ~/.ssh/config includes that file. A backup of ~/.ssh/config is saved first.`,
      "Add Include",
    );
    if (ok) await this.ssh.addInclude();
    return ok;
  }

  private async report(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (e) {
      if (!isCanceled(e)) await this.notifier.error(awsErrorMessage(e));
    }
  }
}
