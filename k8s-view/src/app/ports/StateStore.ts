/** Port: state persisted across sessions (`workspaceState` / `globalState`). */
export abstract class StateStore {
  abstract getWorkspace<T>(key: string): T | undefined;
  abstract setWorkspace(key: string, value: unknown): Thenable<void>;
  abstract getGlobal<T>(key: string): T | undefined;
  abstract setGlobal(key: string, value: unknown): Thenable<void>;
}
