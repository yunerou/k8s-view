import { inject, injectable } from "@needle-di/core";
import { StateStore } from "../../app/ports/StateStore";
import { EXTENSION_CONTEXT } from "../../di/tokens";

@injectable()
export class VscodeStateStore extends StateStore {
  constructor(private readonly context = inject(EXTENSION_CONTEXT)) {
    super();
  }
  getGlobal<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(key);
  }
  async setGlobal(key: string, value: unknown): Promise<void> {
    await this.context.globalState.update(key, value);
  }
}
