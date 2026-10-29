import { inject, injectable } from "@needle-di/core";
import type { Disposable } from "../core/util/Emitter";
import { Settings } from "./ports/Settings";

export interface PollClient {
  /** Whether the view is visible; hidden clients are skipped. */
  visible(): boolean;
  /** Refresh; `true` = pipelines/jobs are still running (poll more frequently). */
  refresh(): Promise<boolean>;
}

/** Shared refresh loop for the tree, Full view, and status bar: faster while work is running, paused when the window loses focus. */
@injectable()
export class Poller implements Disposable {
  private readonly clients = new Set<PollClient>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private focused = true;
  private running = false;
  private pendingNow = false;
  private disposed = false;

  constructor(private readonly settings = inject(Settings)) {}

  register(client: PollClient): Disposable {
    this.clients.add(client);
    return { dispose: () => this.clients.delete(client) };
  }

  start(): void {
    this.schedule(0);
  }

  /** Refresh immediately (Refresh button, after retry/cancel/play, or when a view becomes visible). */
  now(): void {
    if (this.running) this.pendingNow = true;
    else this.schedule(0);
  }

  setFocused(focused: boolean): void {
    const regained = focused && !this.focused;
    this.focused = focused;
    if (regained) this.now();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.clients.clear();
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    // Unfocused: do not schedule another poll; setFocused(true) will restart it.
    if (!this.focused || this.disposed) return;
    this.running = true;
    let active = false;
    try {
      const visible = [...this.clients].filter((c) => c.visible());
      const results = await Promise.allSettled(visible.map((c) => c.refresh()));
      active = results.some((r) => r.status === "fulfilled" && r.value);
    } finally {
      this.running = false;
    }
    if (this.pendingNow) {
      this.pendingNow = false;
      this.schedule(0);
      return;
    }
    const seconds = active ? this.settings.activeRefreshSeconds() : this.settings.idleRefreshSeconds();
    this.schedule(seconds * 1000);
  }
}
