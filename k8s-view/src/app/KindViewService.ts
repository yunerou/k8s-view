import { inject, injectable } from "@needle-di/core";
import { KIND_VIEW_ID, type KindViewTarget, kindViewConfig } from "../core/view/kindView";
import { StateStore } from "./ports/StateStore";
import { ViewRegistry } from "./ViewRegistry";

const KIND_KEY = "k8sView.kindView";

/** "Single resource kind" view: remember the selected kind per workspace and register it as a dynamic view. */
@injectable()
export class KindViewService {
  constructor(
    private readonly views = inject(ViewRegistry),
    private readonly state = inject(StateStore),
  ) {}

  readonly viewId = KIND_VIEW_ID;

  get current(): KindViewTarget | undefined {
    return this.state.getWorkspace<KindViewTarget>(KIND_KEY);
  }

  restore(): void {
    const target = this.current;
    if (target) this.views.setDynamic(kindViewConfig(target));
  }

  async select(target: KindViewTarget): Promise<void> {
    const value = { group: target.group, kind: target.kind, ...(target.plural ? { plural: target.plural } : {}) };
    await this.state.setWorkspace(KIND_KEY, value);
    this.views.setDynamic(kindViewConfig(value));
  }
}
