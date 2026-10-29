import type * as vscode from "vscode";
import type { ClusterContext } from "../core/context/ClusterContext";
import { colorFor, formatLogLine, formatNotice, LineBuffer } from "../core/logs/LogFormat";
import type { KubeResource } from "../core/resource/KubeResource";
import { matchesSelector } from "../core/view/labelSelector";
import { errorMessage } from "./ContextService";
import type { LogSource } from "./ports/LogSource";
import type { ResourceSource } from "./ports/ResourceSource";

const POD = { group: "", kind: "Pod" } as const;
/** Concurrent stream limit (one HTTP connection to the API server per container). */
export const MAX_LOG_STREAMS = 50;
const MAX_FAILURES = 5;

/**
 * Log source: one pod (optionally one container), or all pods matching a workload's selector
 * (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job).
 */
export interface LogTarget {
  readonly context: ClusterContext;
  readonly namespace: string;
  /** Display title, e.g. `deployment/api`. */
  readonly title: string;
  readonly pod?: string;
  readonly selector?: unknown;
  readonly container?: string;
  /** Existing pod object (used without permission to list pods in the namespace). */
  readonly podObject?: KubeResource;
}

export interface LogOptions {
  readonly tailLines: number;
  readonly timestamps: boolean;
  readonly highlight: boolean;
  /** Delay before reconnecting a broken stream (doubled after each consecutive failure). */
  readonly retryDelayMs?: number;
}

/** Sink for formatted lines (ANSI, without trailing newline): `LogTerminal`'s terminal. */
export interface LogSink {
  line(text: string): void;
}

interface ContainerStatus {
  readonly name: string;
  readonly restartCount?: number;
  readonly state?: { running?: unknown; waiting?: unknown; terminated?: unknown };
  readonly lastState?: { terminated?: unknown };
}

interface Stream {
  readonly key: string;
  readonly podUid: string;
  readonly pod: string;
  readonly container: string;
  readonly prefix: string | undefined;
  controller: AbortController | undefined;
  restartCount: number;
  endedAt: string | undefined;
  failures: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A log session: watch namespace Pods (sharing the view's watch), open streams for matching containers,
 * add new pods automatically (rollout, scaling), reconnect on container restarts or disconnections, close streams for deleted pods.
 */
export class LogSession implements vscode.Disposable {
  private readonly streams = new Map<string, Stream>();
  private lease: vscode.Disposable | undefined;
  private listener: vscode.Disposable | undefined;
  private disposed = false;
  private waitingNotice = false;
  private capNotice = false;

  constructor(
    private readonly target: LogTarget,
    private readonly options: LogOptions,
    private readonly source: ResourceSource,
    private readonly logs: LogSource,
    private readonly sink: LogSink,
  ) {}

  /** Number of open streams (tests, title). */
  get activeStreams(): number {
    // Include streams awaiting reconnection (timers), so simultaneous disconnections cannot exceed the limit.
    return [...this.streams.values()].filter((s) => s.controller || s.timer).length;
  }

  start(): void {
    const { context, namespace } = this.target;
    this.sink.line(formatNotice(`Logs of ${this.target.title} · ${namespace} · ${context.name} — Ctrl+C to stop`, "▶"));
    this.lease = this.source.acquire(context, POD, namespace);
    this.listener = this.source.onDidChange((c) => {
      if (c.context === context.name && c.kindKey === "/Pod" && (c.namespace === namespace || !c.namespace))
        this.reconcile();
    });
    this.reconcile();
  }

  /** Stop all streams (Ctrl+C or terminal close). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.streams.values()) this.close(s);
    this.streams.clear();
    this.listener?.dispose();
    this.lease?.dispose();
  }

  private reconcile(): void {
    if (this.disposed) return;
    const lookup = this.source.lookup(this.target.context);
    const entry = lookup.entry(POD, this.target.namespace);
    let pods = lookup.list("", "Pod", this.target.namespace);
    if (entry?.state === "forbidden") {
      // No pod list permission: known pods (opened from tree/table) still work, but new pods are not added automatically.
      pods = this.target.podObject ? [this.target.podObject] : [];
      if (!this.target.podObject && !this.waitingNotice) {
        this.waitingNotice = true;
        this.sink.line(formatNotice(`Cannot list pods: ${entry.message ?? entry.state}`, "!"));
      }
    } else if (entry?.state === "error" && (pods === undefined || pods.length === 0) && this.streams.size > 0) {
      // Watch temporarily failing (network, 410) with no data yet: retain streams and wait for recovery.
      return;
    }
    if (pods === undefined) return;
    const matched = pods.filter((p) => this.matches(p));
    const alive = new Set<string>();
    for (const pod of matched) {
      for (const container of this.containers(pod)) {
        const key = `${pod.uid}/${container}`;
        alive.add(key);
        this.ensure(pod, container, key);
      }
    }
    for (const s of [...this.streams.values()]) {
      if (alive.has(s.key)) continue;
      this.close(s);
      this.streams.delete(s.key);
      this.sink.line(formatNotice(`${s.prefix ?? s.container} — pod ${s.pod} is gone`, "-"));
    }
    if (matched.length === 0 && !this.waitingNotice) {
      this.waitingNotice = true;
      this.sink.line(formatNotice("No matching pods yet — waiting for pods to appear…", "…"));
    } else if (matched.length > 0) {
      this.waitingNotice = false;
    }
  }

  private matches(pod: KubeResource): boolean {
    if (this.target.pod !== undefined) return pod.name === this.target.pod;
    return matchesSelector(this.target.selector, pod.labels);
  }

  private containers(pod: KubeResource): string[] {
    const spec = pod.object["spec"] as { initContainers?: { name: string }[]; containers?: { name: string }[] };
    const names = [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map((c) => c.name);
    return this.target.container ? names.filter((n) => n === this.target.container) : names;
  }

  /** Open a stream if the container has logs and no existing stream; reconnect when the container restarts. */
  private ensure(pod: KubeResource, container: string, key: string): void {
    const status = containerStatus(pod, container);
    const restartCount = status?.restartCount ?? 0;
    const running = !!status?.state?.running;
    const hasLogs = running || !!status?.state?.terminated || !!status?.lastState?.terminated;
    const existing = this.streams.get(key);
    if (existing) {
      if (existing.controller || existing.timer) return;
      // Stream ended: reopen only when the container runs again (new restart).
      if (running && restartCount > existing.restartCount) {
        existing.restartCount = restartCount;
        existing.failures = 0;
        this.sink.line(formatNotice(`${existing.prefix ?? container} restarted (#${restartCount})`, "↻"));
        this.open(existing, existing.endedAt);
      }
      return;
    }
    if (!hasLogs) return;
    if (this.activeStreams >= MAX_LOG_STREAMS) {
      if (!this.capNotice) {
        this.capNotice = true;
        this.sink.line(formatNotice(`More than ${MAX_LOG_STREAMS} containers: only the first are streamed`, "!"));
      }
      return;
    }
    const stream: Stream = {
      key,
      podUid: pod.uid,
      pod: pod.name,
      container,
      prefix: this.prefix(pod.name, container),
      controller: undefined,
      restartCount,
      endedAt: undefined,
      failures: 0,
      timer: undefined,
    };
    this.streams.set(key, stream);
    this.open(stream, undefined);
  }

  private prefix(pod: string, container: string): string | undefined {
    if (this.target.pod === undefined) return `${pod}/${container}`;
    return this.target.container ? undefined : container;
  }

  private open(stream: Stream, sinceTime: string | undefined): void {
    if (this.disposed) return;
    const controller = new AbortController();
    stream.controller = controller;
    stream.timer = undefined;
    const buffer = new LineBuffer();
    const color = colorFor(stream.prefix ?? stream.container);
    const emit = (lines: string[]) => {
      for (const line of lines)
        this.sink.line(
          formatLogLine(line, {
            ...(stream.prefix ? { prefix: stream.prefix } : {}),
            color,
            highlight: this.options.highlight,
          }),
        );
    };
    if (stream.prefix && !sinceTime) this.sink.line(formatNotice(stream.prefix, "+"));
    this.logs
      .stream(
        this.target.context.name,
        {
          namespace: this.target.namespace,
          pod: stream.pod,
          container: stream.container,
          follow: true,
          timestamps: this.options.timestamps,
          ...(sinceTime ? { sinceTime } : { tailLines: this.options.tailLines }),
        },
        (chunk) => {
          if (controller.signal.aborted) return;
          stream.failures = 0;
          emit(buffer.push(chunk));
        },
        controller.signal,
      )
      .then(
        () => this.ended(stream, controller, buffer, emit, undefined),
        (e: unknown) => this.ended(stream, controller, buffer, emit, e),
      );
  }

  private ended(
    stream: Stream,
    controller: AbortController,
    buffer: LineBuffer,
    emit: (lines: string[]) => void,
    error: unknown,
  ): void {
    if (stream.controller !== controller) return;
    stream.controller = undefined;
    if (controller.signal.aborted || this.disposed) return;
    emit(buffer.flush());
    stream.endedAt = new Date().toISOString();
    const label = stream.prefix ?? stream.container;
    if (error) {
      stream.failures++;
      this.sink.line(formatNotice(`${label}: ${errorMessage(error)}`, "!"));
    }
    // Container still running but stream disconnected (API server timeout, network): reconnect after a delay.
    const pod =
      this.source
        .lookup(this.target.context)
        .list("", "Pod", this.target.namespace)
        ?.find((p) => p.uid === stream.podUid) ??
      (this.target.podObject?.uid === stream.podUid ? this.target.podObject : undefined);
    const status = pod ? containerStatus(pod, stream.container) : undefined;
    stream.restartCount = Math.max(stream.restartCount, status?.restartCount ?? 0);
    const retry = !!status?.state?.running && stream.failures < MAX_FAILURES;
    if (!retry) {
      this.sink.line(formatNotice(`${label} — stream ended`, "-"));
      return;
    }
    const delay = (this.options.retryDelayMs ?? 2000) * 2 ** Math.max(0, stream.failures - 1);
    stream.timer = setTimeout(() => {
      stream.timer = undefined;
      if (this.streams.get(stream.key) === stream) this.open(stream, stream.endedAt);
    }, delay);
  }

  private close(stream: Stream): void {
    stream.controller?.abort();
    stream.controller = undefined;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
  }
}

function containerStatus(pod: KubeResource, container: string): ContainerStatus | undefined {
  const status = pod.object["status"] as
    | { initContainerStatuses?: ContainerStatus[]; containerStatuses?: ContainerStatus[] }
    | undefined;
  return [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])].find(
    (s) => s.name === container,
  );
}

/** Log target for a resource: pod by name, workload by `spec.selector`. `undefined` = kind has no logs. */
export function logTargetFor(
  context: ClusterContext,
  resource: KubeResource,
  container?: string,
): LogTarget | undefined {
  const namespace = resource.namespace;
  if (!namespace) return undefined;
  const kindLower = resource.kind.kind.toLowerCase();
  if (resource.kind.group === "" && resource.kind.kind === "Pod") {
    return {
      context,
      namespace,
      title: container ? `pod/${resource.name} -c ${container}` : `pod/${resource.name}`,
      pod: resource.name,
      ...(container ? { container } : {}),
      podObject: resource,
    };
  }
  const selector = (resource.object["spec"] as { selector?: unknown } | undefined)?.selector;
  if (!selector || typeof selector !== "object") return undefined;
  return { context, namespace, title: `${kindLower}/${resource.name}`, selector };
}
