/** Port: `globalState`, shared by every VS Code window of this user. `undefined` removes the key. */
export abstract class StateStore {
  abstract getGlobal<T>(key: string): T | undefined;
  abstract setGlobal(key: string, value: unknown): Promise<void>;
}
