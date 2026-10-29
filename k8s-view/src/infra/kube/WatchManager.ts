import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import type { EntryState, KindRef, ResourceChange, WatchSummary } from "../../app/ports/ResourceSource";
import { Settings } from "../../app/ports/Settings";
import type { KubeObject } from "../../core/resource/KubeResource";
import type { ResourceKind } from "../../core/resource/ResourceKind";
import { LOGGER } from "../../di/tokens";
import { DiscoveryService } from "./DiscoveryService";
import { KubeTransport, type WatchEvent, type WatchHandle } from "./KubeTransport";
import { ResourceStore } from "./ResourceStore";

export interface KindResolver {
  resolve(context: string, ref: KindRef): Promise<ResourceKind | undefined>;
}

export interface WatchLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface WatchEntryInfo {
  readonly namespace: string | undefined;
  readonly state: EntryState;
  readonly message: string | undefined;
  readonly kind: ResourceKind | undefined;
  readonly store: ResourceStore | undefined;
}

interface Entry {
  readonly key: string;
  readonly context: string;
  readonly ref: KindRef;
  readonly namespace: string | undefined;
  refs: number;
  kind: ResourceKind | undefined;
  store: ResourceStore | undefined;
  state: EntryState;
  message: string | undefined;
  resourceVersion: string | undefined;
  watch: WatchHandle | undefined;
  /** Watch is open or opening (including connection setup), for the `maxWatches` limit. */
  watching: boolean;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  backoffMs: number;
  /** Incremented on each stop/restart: callbacks from older runs ignore themselves. */
  generation: number;
  /** 403 on `watch` but `list` succeeds: permanently switch to polling. */
  forcePoll: boolean;
  /** Closed (old leases may still reference it): all operations on this entry are ignored. */
  closed: boolean;
}

const GRACE_MS = 30_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function statusOf(e: unknown): number | undefined {
  if (!e || typeof e !== "object") return undefined;
  const o = e as { status?: unknown; statusCode?: unknown; code?: unknown };
  const v = o.status ?? o.statusCode ?? (typeof o.code === "number" ? o.code : undefined);
  return typeof v === "number" ? v : undefined;
}

const keyOf = (context: string, ref: KindRef, ns: string | undefined) =>
  `${context}|${ref.group}/${ref.kind}|${ns ?? "*"}`;

/**
 * Reference-counted informer: one watch per (context, kind, namespace), shared across views.
 * List → watch from resourceVersion; 410 → relist; network error → backoff 1 s → 30 s; 403 on watch → polling.
 * Close 30 s after the final lease is released.
 */
@injectable()
export class WatchManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ResourceChange>();
  readonly onDidChange = this.changed.event;
  private readonly summaryChanged = new vscode.EventEmitter<WatchSummary>();
  readonly onDidChangeSummary = this.summaryChanged.event;
  private readonly entries = new Map<string, Entry>();
  private paused = false;
  private lastSummary = "";
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly transport: KubeTransport = inject(KubeTransport),
    private readonly kinds: KindResolver = inject(DiscoveryService),
    private readonly settings: Settings = inject(Settings),
    private readonly log: WatchLog = inject(LOGGER),
  ) {
    this.disposables.push(
      settings.onDidChange((keys) => {
        if (
          keys.some(
            (k) =>
              k.startsWith("refresh.mode") ||
              k.startsWith("refresh.maxWatches") ||
              k.startsWith("refresh.pollInterval"),
          )
        ) {
          for (const e of this.entries.values()) this.start(e);
        }
      }),
    );
  }

  get isPaused(): boolean {
    return this.paused;
  }

  acquire(context: string, ref: KindRef, namespace: string | undefined): { key: string; dispose(): void } {
    const key = keyOf(context, ref, namespace);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        context,
        ref: { group: ref.group, kind: ref.kind },
        namespace,
        refs: 0,
        kind: undefined,
        store: undefined,
        state: "loading",
        message: undefined,
        resourceVersion: undefined,
        watch: undefined,
        watching: false,
        closeTimer: undefined,
        timer: undefined,
        backoffMs: BACKOFF_START_MS,
        generation: 0,
        forcePoll: false,
        closed: false,
      };
      this.entries.set(key, entry);
      this.start(entry);
    }
    const e = entry;
    e.refs++;
    if (e.closeTimer) {
      clearTimeout(e.closeTimer);
      e.closeTimer = undefined;
    }
    let released = false;
    return {
      key,
      dispose: () => {
        if (released) return;
        released = true;
        this.release(e);
      },
    };
  }

  entry(context: string, ref: KindRef, namespace: string | undefined): WatchEntryInfo | undefined {
    const e = this.entries.get(keyOf(context, ref, namespace));
    return e && { namespace: e.namespace, state: e.state, message: e.message, kind: e.kind, store: e.store };
  }

  /** All entries for a context and kind (all namespaces). */
  entriesFor(context: string, ref: KindRef): WatchEntryInfo[] {
    const prefix = `${context}|${ref.group}/${ref.kind}|`;
    return [...this.entries.values()]
      .filter((e) => e.key.startsWith(prefix))
      .map((e) => ({ namespace: e.namespace, state: e.state, message: e.message, kind: e.kind, store: e.store }));
  }

  resync(context: string, refs?: readonly KindRef[]): void {
    for (const e of this.entries.values()) {
      if (e.context !== context) continue;
      if (refs && !refs.some((r) => r.group === e.ref.group && r.kind === e.ref.kind)) continue;
      e.backoffMs = BACKOFF_START_MS;
      this.start(e);
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const e of this.entries.values()) {
      if (paused) {
        this.stop(e);
        this.setState(e, "paused", undefined);
      } else this.start(e);
    }
    this.emitSummary();
  }

  /** Context switch: immediately close watches for other contexts instead of waiting for the grace period. */
  closeContextsExcept(context: string | undefined): void {
    for (const e of [...this.entries.values()]) if (e.context !== context) this.close(e);
  }

  summary(): WatchSummary {
    const all = [...this.entries.values()];
    const errors = all.filter((e) => e.state === "error").length;
    const watches = all.filter((e) => e.watching).length;
    const state: WatchSummary["state"] = this.paused
      ? "paused"
      : errors > 0
        ? "error"
        : all.some((e) => e.state === "polling")
          ? "polling"
          : all.some((e) => e.state === "live")
            ? "live"
            : "idle";
    const message = all.find((e) => e.state === "error")?.message;
    return { state, watches, errors, ...(message ? { message } : {}) };
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) this.close(e);
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
    this.summaryChanged.dispose();
  }

  private release(e: Entry): void {
    if (e.closed) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs > 0 || e.closeTimer) return;
    e.closeTimer = setTimeout(() => this.close(e), GRACE_MS);
  }

  private close(e: Entry): void {
    if (e.closeTimer) clearTimeout(e.closeTimer);
    this.stop(e);
    e.closed = true;
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    this.emitSummary();
  }

  private stop(e: Entry): void {
    e.generation++;
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    e.watch?.abort();
    e.watch = undefined;
    e.watching = false;
  }

  /** (Re)start list + watch/poll for an entry. */
  private start(e: Entry): void {
    this.stop(e);
    if (this.paused) {
      this.setState(e, "paused", undefined);
      return;
    }
    const generation = e.generation;
    void this.run(e, generation);
  }

  private async run(e: Entry, generation: number): Promise<void> {
    const stale = () => generation !== e.generation || e.closed;
    if (!e.kind) {
      try {
        e.kind = await this.kinds.resolve(e.context, e.ref);
      } catch (err) {
        if (stale()) return;
        this.fail(e, err);
        return;
      }
      if (stale()) return;
      if (!e.kind) {
        this.setState(e, "unavailable", `${e.ref.kind} is not served by this cluster`);
        return;
      }
    }
    const kind = e.kind;
    let list: { items: KubeObject[]; resourceVersion: string };
    try {
      list = await this.transport.list(e.context, kind, e.namespace);
    } catch (err) {
      if (stale()) return;
      const status = statusOf(err);
      if (status === 403) {
        this.setState(e, "forbidden", messageOf(err));
        return;
      }
      if (status === 404) {
        this.setState(e, "unavailable", messageOf(err));
        return;
      }
      this.fail(e, err);
      return;
    }
    if (stale()) return;
    e.store ??= new ResourceStore(kind);
    // Metrics objects have no UID/resourceVersion and only support list/get.
    e.store.replace(
      kind.group === "metrics.k8s.io"
        ? list.items.map((o) => ({
            ...o,
            metadata: { ...o.metadata, uid: `${o.metadata.namespace ?? ""}/${o.metadata.name}` },
          }))
        : list.items,
    );
    e.resourceVersion = list.resourceVersion;
    e.backoffMs = BACKOFF_START_MS;

    const mode = this.settings.refreshMode();
    if (mode === "manual") {
      this.setState(e, "live", undefined, true);
      return;
    }
    if (
      kind.group === "metrics.k8s.io" ||
      mode === "poll" ||
      e.forcePoll ||
      this.watchCount() >= this.settings.maxWatches()
    ) {
      this.setState(e, "polling", e.forcePoll ? "No permission to watch; polling instead" : undefined, true);
      this.schedule(e, this.settings.pollIntervalSeconds() * 1000);
      return;
    }
    this.setState(e, "live", undefined, true);
    await this.watch(e, generation);
  }

  private async watch(e: Entry, generation: number): Promise<void> {
    const stale = () => generation !== e.generation || e.closed;
    const kind = e.kind!;
    e.watching = true;
    try {
      const handle = await this.transport.watch(
        e.context,
        kind,
        e.namespace,
        e.resourceVersion ?? "0",
        (event) => {
          if (!stale()) this.onEvent(e, event);
        },
        (err) => {
          if (!stale()) this.onWatchDone(e, err);
        },
      );
      if (stale()) handle.abort();
      else e.watch = handle;
    } catch (err) {
      if (!stale()) this.onWatchDone(e, err);
    }
  }

  private onEvent(e: Entry, event: WatchEvent): void {
    const rv = event.object?.metadata?.resourceVersion;
    switch (event.type) {
      case "ADDED":
      case "MODIFIED":
        if (rv) e.resourceVersion = rv;
        if (e.store?.upsert(event.object)) this.fireChange(e);
        return;
      case "DELETED":
        if (rv) e.resourceVersion = rv;
        if (e.store?.remove(event.object)) this.fireChange(e);
        return;
      case "BOOKMARK":
        if (rv) e.resourceVersion = rv;
        return;
      case "ERROR": {
        const code = event.object?.code;
        if (code === 410) this.start(e);
        else this.fail(e, Object.assign(new Error(event.object?.message ?? "watch error"), { status: code }));
      }
    }
  }

  private onWatchDone(e: Entry, err: unknown): void {
    e.watch = undefined;
    e.watching = false;
    if (!err) {
      // Server periodically closes connections: resume watching from the last resourceVersion.
      const generation = ++e.generation;
      void this.watch(e, generation);
      return;
    }
    const status = statusOf(err);
    if (status === 410) {
      this.start(e);
      return;
    }
    if (status === 403) {
      this.log.info(`${e.key}: watch forbidden, switching to polling`);
      e.forcePoll = true;
      this.stop(e);
      this.setState(e, "polling", "No permission to watch; polling instead");
      this.schedule(e, this.settings.pollIntervalSeconds() * 1000);
      return;
    }
    this.fail(e, err);
  }

  private fail(e: Entry, err: unknown): void {
    this.log.warn(`${e.key}: ${messageOf(err)} (retry in ${e.backoffMs / 1000}s)`);
    this.stop(e);
    this.setState(e, "error", messageOf(err));
    this.schedule(e, e.backoffMs);
    e.backoffMs = Math.min(e.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private schedule(e: Entry, delay: number): void {
    if (e.timer) clearTimeout(e.timer);
    const generation = e.generation;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      if (generation !== e.generation || e.closed) return;
      const next = ++e.generation;
      void this.run(e, next);
    }, delay);
  }

  private watchCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.watching) n++;
    return n;
  }

  private setState(e: Entry, state: EntryState, message: string | undefined, dataChanged = false): void {
    const changed = e.state !== state || e.message !== message;
    e.state = state;
    e.message = message;
    if (changed || dataChanged) this.fireChange(e);
    if (changed) this.emitSummary();
  }

  private fireChange(e: Entry): void {
    this.changed.fire({ context: e.context, kindKey: `${e.ref.group}/${e.ref.kind}`, namespace: e.namespace });
  }

  private emitSummary(): void {
    const s = this.summary();
    const key = JSON.stringify(s);
    if (key === this.lastSummary) return;
    this.lastSummary = key;
    this.summaryChanged.fire(s);
  }
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
