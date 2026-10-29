import { inject, injectable } from "@needle-di/core";
import { SecretStore } from "../../app/ports/SecretStore";
import { EXTENSION_CONTEXT } from "../../di/tokens";

@injectable()
export class VscodeSecretStore extends SecretStore {
  constructor(private readonly context = inject(EXTENSION_CONTEXT)) {
    super();
  }
  async get(key: string): Promise<string | undefined> {
    return this.context.secrets.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    await this.context.secrets.store(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.context.secrets.delete(key);
  }
}
