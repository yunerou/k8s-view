import { inject, injectable } from "@needle-di/core";
import { StateStore } from "../../app/ports/StateStore";
import { EXTENSION_CONTEXT } from "../../di/tokens";

@injectable()
export class VscodeStateStore extends StateStore {
  constructor(private readonly context = inject(EXTENSION_CONTEXT)) {
    super();
  }
  getWorkspace<T>(key: string): T | undefined {
    return this.context.workspaceState.get<T>(key);
  }
  setWorkspace(key: string, value: unknown): Thenable<void> {
    return this.context.workspaceState.update(key, value);
  }
  getGlobal<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(key);
  }
  setGlobal(key: string, value: unknown): Thenable<void> {
    return this.context.globalState.update(key, value);
  }
}
