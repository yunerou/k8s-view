import { inject, injectable } from "@needle-di/core";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { StateStore } from "./ports/StateStore";

const KEY = "awsView.instances";

export interface InstanceSettings {
  readonly sshUser?: string;
  readonly fallbackKeyPath?: string;
  readonly pinned?: boolean;
  /** Where the instance was last opened in Remote: lets its Remote window find it again. */
  readonly profile?: string;
  readonly region?: string;
  readonly name?: string;
}

/** Per-instance preferences in globalState (shared by every window). */
@injectable()
export class InstanceSettingsStore implements Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly store = inject(StateStore)) {}

  get(id: string): InstanceSettings {
    return this.all()[id] ?? {};
  }

  pinned(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.all())
        .filter(([, s]) => s.pinned)
        .map(([id]) => id),
    );
  }

  async update(id: string, patch: InstanceSettings): Promise<void> {
    const all = this.all();
    await this.store.setGlobal(KEY, { ...all, [id]: { ...all[id], ...patch } });
    this.changed.fire();
  }

  async unset(id: string, field: keyof InstanceSettings): Promise<void> {
    const all = this.all();
    const current = Object.fromEntries(Object.entries(all[id] ?? {}).filter(([key]) => key !== field));
    await this.store.setGlobal(KEY, { ...all, [id]: current });
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  private all(): Readonly<Record<string, InstanceSettings>> {
    return this.store.getGlobal<Record<string, InstanceSettings>>(KEY) ?? {};
  }
}
