import { inject, injectable } from "@needle-di/core";
import { describeExpiry, expiryState } from "../core/auth/expiry";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { Notifier } from "./ports/Notifier";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";
import { TokenStore } from "./TokenStore";

const WARNED_KEY = "gitlabCiView.expiryWarned";
/** Check four times a day; warn at most once per host per day (persist the last warning date). */
const CHECK_MS = 6 * 3_600_000;

@injectable()
export class TokenExpiryWatcher implements Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly updateRequested = new Emitter<string>();
  /** The user clicked "Update token" for this host. */
  readonly onUpdateRequested = this.updateRequested.event;

  constructor(
    private readonly store = inject(TokenStore),
    private readonly state = inject(StateStore),
    private readonly settings = inject(Settings),
    private readonly notifier = inject(Notifier),
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_MS);
  }

  async check(): Promise<void> {
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    const warned: Record<string, string> = { ...this.state.getGlobal<Record<string, string>>(WARNED_KEY) };
    let dirty = false;
    for (const host of this.store.hosts()) {
      const meta = this.store.meta(host);
      if (!meta || meta.invalid || warned[host] === today) continue;
      const state = expiryState(meta.expiresAt, now, this.settings.tokenExpiryWarningDays());
      if (state.kind !== "expiring" && state.kind !== "expired") continue;
      warned[host] = today;
      dirty = true;
      const message = `The GitLab token for ${host} ${describeExpiry(state)}.`;
      const reply =
        state.kind === "expired"
          ? this.notifier.error(message, "Update token")
          : this.notifier.warn(message, "Update token");
      void reply.then((action) => {
        if (action) this.updateRequested.fire(host);
      });
    }
    if (dirty) await this.state.setGlobal(WARNED_KEY, warned);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.updateRequested.dispose();
  }
}
