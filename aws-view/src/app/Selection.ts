import { inject, injectable } from "@needle-di/core";
import { defaultFilter, type InstanceFilter } from "../core/ec2/filters";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { AuthService } from "./AuthService";
import type { AwsTarget } from "./ports/AwsApi";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";

const REGION_KEY = "awsView.region";
const FILTER_KEY = "awsView.filter";

/** Region and filter of the tree; fires whenever the listed instances must be reloaded. */
@injectable()
export class Selection implements Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: Disposable[];

  constructor(
    private readonly store = inject(StateStore),
    private readonly settings = inject(Settings),
    private readonly auth = inject(AuthService),
  ) {
    this.subs = [
      auth.onDidChange(() => this.changed.fire()),
      settings.onDidChange((keys) => {
        if (keys.includes("regions") || keys.includes("defaultTagFilters")) this.changed.fire();
      }),
    ];
  }

  region(): string | undefined {
    return this.store.getGlobal<string>(REGION_KEY) || this.settings.regions()[0] || this.auth.profile()?.region;
  }

  regionChoices(): string[] {
    const choices = [...this.settings.regions(), this.auth.profile()?.region, this.region()];
    return [...new Set(choices.filter((r): r is string => !!r))];
  }

  async setRegion(region: string): Promise<void> {
    await this.store.setGlobal(REGION_KEY, region);
    this.changed.fire();
  }

  filter(): InstanceFilter {
    return this.store.getGlobal<InstanceFilter>(FILTER_KEY) ?? defaultFilter(this.settings.defaultTagFilters());
  }

  async setFilter(filter: InstanceFilter): Promise<void> {
    await this.store.setGlobal(FILTER_KEY, filter);
    this.changed.fire();
  }

  async clearFilter(): Promise<void> {
    await this.store.setGlobal(FILTER_KEY, undefined);
    this.changed.fire();
  }

  target(): AwsTarget | undefined {
    const profile = this.auth.profile()?.name;
    const region = this.region();
    return profile && region ? { profile, region } : undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
