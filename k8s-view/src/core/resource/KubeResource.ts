import { ResourceKind } from "./ResourceKind";

export interface OwnerReference {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly controller?: boolean;
}

export interface ObjectMeta {
  readonly name: string;
  readonly namespace?: string;
  readonly uid: string;
  readonly resourceVersion?: string;
  readonly creationTimestamp?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly ownerReferences?: readonly OwnerReference[];
  readonly deletionTimestamp?: string;
  readonly generation?: number;
  readonly [key: string]: unknown;
}

/** Raw API server object (processed by `normalizeObject`). */
export interface KubeObject {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata: ObjectMeta;
  readonly [key: string]: unknown;
}

export interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime?: string;
}

export interface ResourceRef {
  readonly group: string;
  readonly version: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace: string | undefined;
}

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** Wrap a raw object with its discovered kind. Immutable: create a new instance when a watch replaces the object. */
export class KubeResource {
  constructor(
    readonly kind: ResourceKind,
    readonly object: KubeObject,
  ) {}

  get uid(): string {
    return this.object.metadata.uid;
  }

  get name(): string {
    return this.object.metadata.name;
  }

  get namespace(): string | undefined {
    return this.object.metadata.namespace || undefined;
  }

  get labels(): Readonly<Record<string, string>> {
    return this.object.metadata.labels ?? {};
  }

  get annotations(): Readonly<Record<string, string>> {
    return this.object.metadata.annotations ?? {};
  }

  get owners(): readonly OwnerReference[] {
    return this.object.metadata.ownerReferences ?? [];
  }

  get ownerUids(): string[] {
    return this.owners.map((o) => o.uid);
  }

  get resourceVersion(): string | undefined {
    return this.object.metadata.resourceVersion;
  }

  get creationTimestamp(): string | undefined {
    return this.object.metadata.creationTimestamp;
  }

  get conditions(): readonly Condition[] {
    const status = this.object["status"] as { conditions?: unknown } | undefined;
    return Array.isArray(status?.conditions) ? (status.conditions as Condition[]) : [];
  }

  condition(type: string): Condition | undefined {
    return this.conditions.find((c) => c.type === type);
  }

  get ref(): ResourceRef {
    return {
      group: this.kind.group,
      version: this.kind.version,
      kind: this.kind.kind,
      name: this.name,
      namespace: this.namespace,
    };
  }

  ageMs(now: number): number | undefined {
    const ts = this.creationTimestamp;
    return ts ? now - Date.parse(ts) : undefined;
  }

  /** Stable UI key when UID is insufficient (pseudo-nodes): `group/kind/ns/name`. */
  get displayKey(): string {
    return `${this.kind.key}/${this.namespace ?? ""}/${this.name}`;
  }
}

export function isSecretKind(kind: Pick<ResourceKind, "group" | "kind">): boolean {
  return kind.group === "" && kind.kind === "Secret";
}

/**
 * Normalize before storing: remove `managedFields` (memory-heavy); replace Secret values with sizes,
 * remove `stringData` and the last-applied annotation (contains actual values) — Secret data never reaches the store/UI/commands.
 */
export function normalizeObject(kind: Pick<ResourceKind, "group" | "kind">, raw: KubeObject): KubeObject {
  const { managedFields: _drop, ...metadata } = raw.metadata as ObjectMeta & { managedFields?: unknown };
  if (!isSecretKind(kind)) return { ...raw, metadata };
  const annotations = metadata.annotations ? { ...metadata.annotations } : undefined;
  if (annotations) delete annotations[LAST_APPLIED];
  const { stringData: _s, data, ...rest } = raw as KubeObject & { data?: Record<string, string>; stringData?: unknown };
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) masked[k] = `<${base64Size(v)} bytes>`;
  return { ...rest, metadata: annotations ? { ...metadata, annotations } : metadata, data: masked };
}

function base64Size(value: string): number {
  const clean = value.replace(/\s/g, "");
  if (clean.length === 0) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return (clean.length * 3) / 4 - padding;
}

export { ResourceKind };
