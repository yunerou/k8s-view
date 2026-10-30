import { inject, injectable } from "@needle-di/core";
import { awsErrorMessage } from "../core/aws/errors";
import { ec2Filters, matchesClient } from "../core/ec2/filters";
import { byLabel, type Instance, type InstanceState, instanceLabel, isTransitional } from "../core/ec2/model";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { sleep } from "../core/util/sleep";
import { diffTags, type TagRow, validateTags } from "../shared/tags";
import { AuthService } from "./AuthService";
import { InstanceSettingsStore } from "./InstanceSettingsStore";
import { AwsApi, type AwsTarget } from "./ports/AwsApi";
import { Selection } from "./Selection";

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;
const WAIT_POLL_MS = 5_000;
/** Each waiting phase (stop, start, SSM online) may take this long. */
const PHASE_TIMEOUT_MS = 5 * 60_000;

export type ListState =
  | { readonly kind: "noProfile" }
  | { readonly kind: "noRegion" }
  | { readonly kind: "signedOut"; readonly profile: string }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly instances: readonly Instance[]; readonly error?: string };

export class SsmTimeoutError extends Error {
  constructor(label: string) {
    super(
      `${label}: the SSM agent did not come online within 5 minutes. Check that the instance profile has AmazonSSMManagedInstanceCore, that the SSM agent is running, and that the instance can reach SSM (NAT, or VPC endpoints ssm, ssmmessages and ec2messages).`,
    );
    this.name = "SsmTimeoutError";
  }
}

type Phase = "stop" | "start" | "ssm";

/** Instances of the selected profile/region: list, poll, start/stop, wait until reachable. */
@injectable()
export class InstanceService implements Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private all: readonly Instance[] = [];
  private loaded = false;
  private error: string | undefined;
  /** Incremented on every load: only the latest load may update the list. */
  private loadSeq = 0;
  private refreshing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private readonly subs: Disposable[];

  constructor(
    private readonly api = inject(AwsApi),
    private readonly auth = inject(AuthService),
    private readonly selection = inject(Selection),
    private readonly store = inject(InstanceSettingsStore),
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.subs = [selection.onDidChange(() => this.reset()), store.onDidChange(() => this.changed.fire())];
  }

  listState(): ListState {
    if (!this.auth.profile()) return { kind: "noProfile" };
    const target = this.selection.target();
    if (!target) return { kind: "noRegion" };
    if (!this.auth.isSignedIn()) return { kind: "signedOut", profile: target.profile };
    if (!this.loaded) return { kind: "loading" };
    const filter = this.selection.filter();
    const pinned = this.store.pinned();
    const instances = this.all.filter((i) => matchesClient(i, filter, pinned));
    return this.error ? { kind: "ready", instances, error: this.error } : { kind: "ready", instances };
  }

  /** Every instance of the last list, without client-side filters. */
  instances(): readonly Instance[] {
    return this.all;
  }

  get(id: string): Instance | undefined {
    return this.all.find((i) => i.id === id);
  }

  setVisible(visible: boolean): void {
    const appeared = visible && !this.visible;
    this.visible = visible;
    if (appeared) void this.refresh();
    else this.schedule();
  }

  /**
   * Reload when signed in (never prompts). Calls made while a load runs share it, unless `force`: after a change
   * (selection, tags) a new load starts and the older one is dropped.
   */
  refresh(force = false): Promise<void> {
    if (this.refreshing && !force) return this.refreshing;
    const seq = ++this.loadSeq;
    const promise = this.load(seq).finally(() => {
      if (this.refreshing === promise) this.refreshing = undefined;
    });
    this.refreshing = promise;
    return promise;
  }

  async start(id: string, target: AwsTarget = this.requireTarget()): Promise<void> {
    await this.api.startInstance(target, id);
    this.markState(id, "pending");
  }

  async stop(id: string, target: AwsTarget = this.requireTarget()): Promise<void> {
    await this.api.stopInstance(target, id);
    this.markState(id, "stopping");
  }

  /** Sets the Name tag; an empty name removes it. */
  async rename(id: string, name: string): Promise<void> {
    const target = this.requireTarget();
    const trimmed = name.trim();
    if (trimmed) await this.api.createTags(target, id, { Name: trimmed });
    else await this.api.deleteTags(target, id, ["Name"]);
    await this.refresh(true);
  }

  /** Apply the tag editor rows. Returns a message for the form, `undefined` on success; `aws:` tags are kept. */
  async saveTags(id: string, rows: readonly TagRow[]): Promise<string | undefined> {
    const validation = validateTags(rows);
    if (validation.error) return validation.error;
    if (validation.rows.some((e) => e !== undefined)) return "Fix the highlighted tags first.";
    const instance = this.get(id);
    if (!instance) return `Instance ${id} is no longer listed. Refresh and try again.`;
    const diff = diffTags(instance.tags, rows);
    try {
      const target = this.requireTarget();
      if (diff.toDelete.length > 0) await this.api.deleteTags(target, id, diff.toDelete);
      if (Object.keys(diff.toCreate).length > 0) await this.api.createTags(target, id, diff.toCreate);
    } catch (e) {
      return awsErrorMessage(e);
    }
    await this.refresh(true);
    return undefined;
  }

  /** Start the instance if needed, then wait until it runs and its SSM agent is online. */
  async ensureOnline(id: string, signal: AbortSignal, report: (message: string) => void = () => {}): Promise<Instance> {
    const target = this.requireTarget();
    let started = false;
    let phase: Phase | undefined;
    let deadline = 0;
    let lastMessage = "";
    const step = (next: Phase, message: string) => {
      if (phase !== next) {
        phase = next;
        deadline = this.now() + PHASE_TIMEOUT_MS;
      }
      if (message !== lastMessage) {
        lastMessage = message;
        report(message);
      }
    };
    for (;;) {
      signal.throwIfAborted();
      const [instance] = await this.api.describeInstances(target, [], [id]);
      if (!instance) throw new Error(`Instance ${id} was not found in ${target.region}.`);
      if (instance.state === "running") {
        const ssm = (await this.api.ssmPing(target, [id])).get(id);
        if (ssm === "Online") {
          const ready = { ...instance, ssm };
          this.upsert(ready);
          return ready;
        }
        step("ssm", "Waiting for the SSM agent…");
      } else if (instance.state === "stopped" && !started) {
        step("start", "Starting instance…");
        await this.api.startInstance(target, id);
        started = true;
        this.markState(id, "pending");
      } else if (instance.state === "pending" || instance.state === "stopped") {
        step("start", "Waiting for the instance to run…");
      } else if (instance.state === "stopping") {
        step("stop", "Waiting for the instance to stop before starting it…");
      } else {
        throw new Error(`${instanceLabel(instance)} is ${instance.state}.`);
      }
      if (this.now() > deadline) {
        if (phase === "ssm") throw new SsmTimeoutError(instanceLabel(instance));
        throw new Error(`Timed out waiting for ${instanceLabel(instance)} to ${phase === "stop" ? "stop" : "start"}.`);
      }
      await this.sleepFn(WAIT_POLL_MS, signal);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }

  private requireTarget(): AwsTarget {
    const target = this.selection.target();
    if (!target) throw new Error("Select an AWS profile and a region first.");
    return target;
  }

  private reset(): void {
    this.all = [];
    this.loaded = false;
    this.error = undefined;
    this.changed.fire();
    void this.refresh(true);
  }

  private async load(seq: number): Promise<void> {
    const target = this.selection.target();
    if (!target || !this.auth.isSignedIn()) {
      this.changed.fire();
      return;
    }
    try {
      const [instances, pings] = await Promise.all([
        this.api.describeInstances(target, ec2Filters(this.selection.filter())),
        this.api.ssmPing(target),
      ]);
      if (seq !== this.loadSeq) return;
      this.all = instances.map((i) => ({ ...i, ssm: pings.get(i.id) })).sort(byLabel);
      this.error = undefined;
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.error = awsErrorMessage(e);
    }
    this.loaded = true;
    this.schedule();
    this.changed.fire();
  }

  /** 5 s while something changes state, 60 s while the view is visible, otherwise only on demand. */
  private schedule(): void {
    clearTimeout(this.timer);
    const active = this.all.some((i) => isTransitional(i.state));
    if (!active && !this.visible) return;
    this.timer = setTimeout(() => void this.refresh(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  private markState(id: string, state: InstanceState): void {
    this.all = this.all.map((i) => (i.id === id ? { ...i, state, ssm: undefined } : i));
    this.changed.fire();
    this.schedule();
  }

  private upsert(instance: Instance): void {
    if (!this.all.some((i) => i.id === instance.id)) return;
    this.all = this.all.map((i) => (i.id === instance.id ? instance : i));
    this.changed.fire();
  }
}
