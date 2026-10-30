import { inject, injectable } from "@needle-di/core";
import { type Instance, instanceLabel, uptimeMs } from "../core/ec2/model";
import { nextMidnight, type ReminderRecord, reminderDue } from "../core/reminder";
import { instanceIdFromAuthority } from "../core/ssh/hostBlock";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { formatDuration } from "../core/util/format";
import { AuthService } from "./AuthService";
import { InstanceActions } from "./InstanceActions";
import { InstanceService } from "./InstanceService";
import { InstanceSettingsStore } from "./InstanceSettingsStore";
import { AwsApi, type AwsTarget } from "./ports/AwsApi";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";
import { Workbench } from "./ports/Workbench";

const RECORDS_KEY = "awsView.reminder";
const SNOOZE_MS = 3_600_000;
const TICK_MS = 60_000;
const LOCAL_CHECK_MS = 30 * 60_000;
const REMOTE_REFRESH_MS = 10 * 60_000;

type ReminderAction = "Stop" | "Snooze 1h" | "Not today";

export interface RemoteStatus {
  readonly instance: Instance;
  /** `undefined` once the instance no longer runs. */
  readonly uptimeMs: number | undefined;
}

/**
 * Reminds to stop instances that keep running: the instance of this Remote window, or pinned instances in a local
 * window. Records live in globalState so only one window shows a given reminder.
 */
@injectable()
export class IdleReminder implements Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private timer: ReturnType<typeof setInterval> | undefined;
  private remote: Instance | undefined;
  private lastRemoteRefresh = Number.NEGATIVE_INFINITY;
  private lastLocalCheck = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly instances = inject(InstanceService),
    private readonly actions = inject(InstanceActions),
    private readonly api = inject(AwsApi),
    private readonly auth = inject(AuthService),
    private readonly store = inject(InstanceSettingsStore),
    private readonly state = inject(StateStore),
    private readonly settings = inject(Settings),
    private readonly workbench = inject(Workbench),
    private readonly notifier = inject(Notifier),
    private readonly prompter = inject(Prompter),
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    this.backgroundTick();
    this.timer = setInterval(() => this.backgroundTick(), TICK_MS);
  }

  private backgroundTick(): void {
    // Background reminders are best effort; storage/API failures are retried on the next tick.
    void this.tick().catch(() => {});
  }

  /** Instance of this window when it is an AWS View Remote window. */
  remoteInstanceId(): string | undefined {
    return instanceIdFromAuthority(this.workbench.remoteAuthority());
  }

  remoteStatus(): RemoteStatus | undefined {
    return this.remote ? { instance: this.remote, uptimeMs: uptimeMs(this.remote, this.now()) } : undefined;
  }

  /** Every minute: update the Remote uptime; AWS is called every 10 minutes (Remote) or 30 minutes (local). */
  async tick(): Promise<void> {
    const now = this.now();
    const remoteId = this.remoteInstanceId();
    if (remoteId) {
      if (!this.remote || now - this.lastRemoteRefresh >= REMOTE_REFRESH_MS) {
        this.lastRemoteRefresh = now;
        await this.refreshRemote(remoteId);
      }
      if (this.remote && this.remoteTarget(remoteId) && this.auth.isSignedIn()) {
        await this.remind([this.remote], true);
      }
      this.changed.fire();
      return;
    }
    if (now - this.lastLocalCheck < LOCAL_CHECK_MS) return;
    this.lastLocalCheck = now;
    // Never prompt for MFA just to remind.
    if (!this.settings.idleReminderEnabled() || !this.auth.isSignedIn()) return;
    await this.instances.refresh();
    const pinned = this.store.pinned();
    await this.remind(
      this.instances.instances().filter((i) => pinned.has(i.id)),
      false,
    );
  }

  /** Click on the Remote status bar item. */
  async promptActions(): Promise<void> {
    const status = this.remoteStatus();
    if (!status || !this.remoteTarget(status.instance.id)) return;
    const action = await this.prompter.pick<ReminderAction>(
      [
        { label: "$(debug-stop) Stop instance", value: "Stop" },
        { label: "$(clock) Snooze the reminder for 1 hour", value: "Snooze 1h" },
        { label: "$(bell-slash) No more reminders today", value: "Not today" },
      ],
      { title: `${instanceLabel(status.instance)} · up ${formatDuration(status.uptimeMs ?? 0)}` },
    );
    await this.handle(status.instance, action, true);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.changed.dispose();
  }

  private async refreshRemote(id: string): Promise<void> {
    const target = this.remoteTarget(id);
    if (!target || !this.auth.isSignedIn()) return;
    try {
      const [instance] = await this.api.describeInstances(target, [], [id]);
      this.remote = instance;
    } catch {
      // Keep the last known state; the next refresh retries.
    }
  }

  /** Profile/region recorded when the instance was opened in Remote, if that profile is the selected one. */
  private remoteTarget(id: string): AwsTarget | undefined {
    const record = this.store.get(id);
    const profile = this.auth.profile()?.name;
    return record.region && profile && record.profile === profile ? { profile, region: record.region } : undefined;
  }

  private async remind(list: readonly Instance[], inRemoteWindow: boolean): Promise<void> {
    if (!this.settings.idleReminderEnabled()) return;
    const hours = this.settings.idleReminderHours();
    for (const i of list) {
      const now = this.now();
      const up = uptimeMs(i, now);
      const record = this.records()[i.id];
      if (up === undefined || !reminderDue(up, hours, now, record)) continue;
      // Claim the reminder before showing it, so other windows stay quiet.
      await this.setRecord(i.id, { ...record, nextAt: now + SNOOZE_MS });
      void this.notifier
        .warn(`${instanceLabel(i)} has been running for ${formatDuration(up)}.`, "Stop", "Snooze 1h", "Not today")
        .then((action) => this.handle(i, action, inRemoteWindow))
        .catch(() => {});
    }
  }

  private async handle(i: Instance, action: string | undefined, inRemoteWindow: boolean): Promise<void> {
    const record = this.records()[i.id];
    if (action === "Snooze 1h") {
      await this.setRecord(i.id, { ...record, nextAt: this.now() + SNOOZE_MS });
    } else if (action === "Not today") {
      await this.setRecord(i.id, { ...record, mutedUntil: nextMidnight(this.now()) });
    } else if (action === "Stop") {
      const target = inRemoteWindow ? this.remoteTarget(i.id) : undefined;
      if (inRemoteWindow && !target) return;
      const stopped = await this.actions.stop(i, {
        ...(target ? { target } : {}),
        ...(inRemoteWindow ? { warning: "This window will lose its connection." } : {}),
      });
      if (stopped && inRemoteWindow) {
        this.remote = { ...i, state: "stopping" };
        this.changed.fire();
      }
    }
  }

  private records(): Readonly<Record<string, ReminderRecord>> {
    return this.state.getGlobal<Record<string, ReminderRecord>>(RECORDS_KEY) ?? {};
  }

  private async setRecord(id: string, record: ReminderRecord): Promise<void> {
    await this.state.setGlobal(RECORDS_KEY, { ...this.records(), [id]: record });
  }
}
