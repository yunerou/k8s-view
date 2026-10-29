import { type KubeObject, KubeResource, normalizeObject } from "../../core/resource/KubeResource";
import type { ResourceKind } from "../../core/resource/ResourceKind";

/** In-memory store for a watch: mapped by `uid`, indexed by `ownerUid`. Objects are normalized before storage. */
export class ResourceStore {
  private readonly byUid = new Map<string, KubeResource>();
  private readonly owners = new Map<string, Set<string>>();
  private snapshot: KubeResource[] | undefined;

  constructor(readonly kind: ResourceKind) {}

  get size(): number {
    return this.byUid.size;
  }

  items(): readonly KubeResource[] {
    this.snapshot ??= [...this.byUid.values()];
    return this.snapshot;
  }

  get(uid: string): KubeResource | undefined {
    return this.byUid.get(uid);
  }

  find(namespace: string | undefined, name: string): KubeResource | undefined {
    for (const r of this.byUid.values()) if (r.name === name && r.namespace === namespace) return r;
    return undefined;
  }

  byOwner(ownerUid: string): KubeResource[] {
    return [...(this.owners.get(ownerUid) ?? [])].map((uid) => this.byUid.get(uid)!).filter(Boolean);
  }

  replace(objects: readonly KubeObject[]): void {
    this.byUid.clear();
    this.owners.clear();
    this.snapshot = undefined;
    for (const o of objects) this.upsert(o);
  }

  /** Return `false` if the object is unchanged (same resourceVersion). */
  upsert(raw: KubeObject): boolean {
    const uid = raw.metadata?.uid;
    if (!uid) return false;
    const previous = this.byUid.get(uid);
    if (previous?.resourceVersion && previous.resourceVersion === raw.metadata.resourceVersion) return false;
    if (previous) this.unindex(previous);
    const resource = new KubeResource(
      this.kind,
      normalizeObject(this.kind, { ...raw, apiVersion: this.kind.apiVersion, kind: this.kind.kind }),
    );
    this.byUid.set(uid, resource);
    for (const owner of resource.ownerUids) {
      const set = this.owners.get(owner) ?? new Set<string>();
      set.add(uid);
      this.owners.set(owner, set);
    }
    this.snapshot = undefined;
    return true;
  }

  remove(raw: KubeObject): boolean {
    const existing = this.byUid.get(raw.metadata?.uid ?? "");
    if (!existing) return false;
    this.unindex(existing);
    this.byUid.delete(existing.uid);
    this.snapshot = undefined;
    return true;
  }

  private unindex(r: KubeResource): void {
    for (const owner of r.ownerUids) this.owners.get(owner)?.delete(r.uid);
  }
}
