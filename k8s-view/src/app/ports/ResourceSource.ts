import type * as vscode from "vscode";
import type { ClusterContext } from "../../core/context/ClusterContext";
import type { KubeObject, KubeResource } from "../../core/resource/KubeResource";
import type { ResourceKind } from "../../core/resource/ResourceKind";
import type { ResourceLookup } from "../../core/view/RelationResolver";

export interface KindRef {
  readonly group: string;
  readonly kind: string;
}

/**
 * Watch state: `loading` (listing), `live` (watching), `polling` (fallback/poll mode), `paused`,
 * `error` (backoff), `forbidden` (403 on list), `unavailable` (kind not served by the cluster).
 */
export type EntryState = "loading" | "live" | "polling" | "paused" | "error" | "forbidden" | "unavailable";

export interface EntryInfo {
  readonly state: EntryState;
  readonly message?: string;
  readonly kind?: ResourceKind;
}

export interface ResourceChange {
  readonly context: string;
  readonly kindKey: string;
  /** `undefined` = watch the entire cluster. */
  readonly namespace: string | undefined;
}

/** Aggregate state for the Context panel and status bar. */
export interface WatchSummary {
  readonly state: "idle" | "live" | "polling" | "paused" | "error";
  readonly watches: number;
  readonly errors: number;
  readonly message?: string;
}

export interface SecretPayload {
  readonly type: string | undefined;
  readonly data: Readonly<Record<string, string>>;
}

export interface ResourceLease extends vscode.Disposable {
  readonly key: string;
}

export interface ContextLookup extends ResourceLookup {
  entry(ref: KindRef, namespace: string | undefined): EntryInfo | undefined;
}

/** Port: cluster resource data (list + watch, cached in memory); infra binds `KubeResourceSource`. */
export abstract class ResourceSource {
  abstract readonly onDidChange: vscode.Event<ResourceChange>;
  abstract readonly onDidChangeSummary: vscode.Event<WatchSummary>;
  /** Open or share a watch for a kind; undefined `namespace` = all namespaces. Disposing the lease releases a reference. */
  abstract acquire(ctx: ClusterContext, ref: KindRef, namespace: string | undefined): ResourceLease;
  abstract lookup(ctx: ClusterContext): ContextLookup;
  abstract resolveKind(ctx: ClusterContext, ref: KindRef): Promise<ResourceKind | undefined>;
  /** Whether the cluster serves these API groups (for view/preset `requires`). */
  abstract hasGroups(ctx: ClusterContext, groups: readonly string[]): Promise<boolean>;
  /** All kinds served by the cluster ("Create custom view" wizard). */
  abstract listKinds(ctx: ClusterContext): Promise<ResourceKind[]>;
  /** Fresh GET from the API server (normalized: Secrets masked). */
  abstract get(
    ctx: ClusterContext,
    kind: ResourceKind,
    namespace: string | undefined,
    name: string,
  ): Promise<KubeResource>;
  /** Actual value of a Secret key (Reveal/Copy) — bypasses the store. */
  abstract readSecretValue(ctx: ClusterContext, namespace: string, name: string, key: string): Promise<string>;
  /** Full Secret `type` + `data` (base64) for "Decrypt secret" — bypasses the store. */
  abstract readSecret(ctx: ClusterContext, namespace: string, name: string): Promise<SecretPayload>;
  /** Resource names for a kind (command/snippet `pick` input with `fromKind`); list once without watching. */
  abstract listNames(ctx: ClusterContext, ref: KindRef, namespace: string | undefined): Promise<string[]>;
  /** One-time list (no watch), with server-side label selector filtering; results are normalized. */
  abstract listResources(
    ctx: ClusterContext,
    ref: KindRef,
    namespace: string | undefined,
    labelSelector?: string,
  ): Promise<KubeResource[]>;
  /** Events related to an object (Events drawer). */
  abstract events(ctx: ClusterContext, resource: KubeResource): Promise<KubeObject[]>;
  /** List again; omitted `refs` = all open kinds for the context. */
  abstract resync(ctx: ClusterContext, refs?: readonly KindRef[]): void;
  abstract setPaused(paused: boolean): void;
  abstract get paused(): boolean;
  abstract summary(): WatchSummary;
}
