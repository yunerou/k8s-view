/** Port: VS Code secret storage (OS keychain). */
export abstract class SecretStore {
  abstract get(key: string): Promise<string | undefined>;
  abstract store(key: string, value: string): Promise<void>;
  abstract delete(key: string): Promise<void>;
}
