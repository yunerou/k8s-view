import { inject, injectable } from "@needle-di/core";
import type { FilterState } from "../core/gitlab/model";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";
import { type RepoRef, RepoRegistry } from "./RepoRegistry";

export const ALL = "all";
const SELECTION_KEY = "gitlabCiView.selection";
const FILTERS_KEY = "gitlabCiView.filters";

/** Selected repository (`all` or repository ID) and pipeline filters, persisted per workspace. Shared by the tree and Full view. */
@injectable()
export class RepoSelection implements Disposable {
  private readonly changed = new Emitter<void>();
  /** Fires when the selection, filters, or repository list changes. */
  readonly onDidChange = this.changed.event;
  private readonly sub: Disposable;

  constructor(
    private readonly repos = inject(RepoRegistry),
    private readonly state = inject(StateStore),
    private readonly settings = inject(Settings),
  ) {
    this.sub = repos.onDidChange(() => this.changed.fire());
  }

  get selection(): string {
    const s = this.state.getWorkspace<string>(SELECTION_KEY) ?? ALL;
    return s !== ALL && this.repos.get(s) ? s : ALL;
  }

  visibleRepos(): readonly RepoRef[] {
    const s = this.selection;
    if (s === ALL) return this.repos.repos();
    const repo = this.repos.get(s);
    return repo ? [repo] : [];
  }

  async select(selection: string): Promise<void> {
    await this.state.setWorkspace(SELECTION_KEY, selection);
    this.changed.fire();
  }

  get filters(): FilterState {
    return {
      ref: this.settings.defaultRefFilter(),
      status: "",
      source: "",
      mine: false,
      ...this.state.getWorkspace<Partial<FilterState>>(FILTERS_KEY),
    };
  }

  async setFilters(filters: FilterState): Promise<void> {
    await this.state.setWorkspace(FILTERS_KEY, filters);
    this.changed.fire();
  }

  /** Reset filters to defaults (based on `gitlabCiView.defaultRefFilter`). */
  async resetFilters(): Promise<void> {
    await this.state.setWorkspace(FILTERS_KEY, undefined);
    this.changed.fire();
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
