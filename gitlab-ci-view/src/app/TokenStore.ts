import { inject, injectable } from "@needle-di/core";
import { Emitter } from "../core/util/Emitter";
import { SecretStore } from "./ports/SecretStore";
import { StateStore } from "./ports/StateStore";

export interface TokenMeta {
  /** `YYYY-MM-DD` date; `null` = never expires. */
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  /** Token owner's username (for the "Only mine" filter). */
  readonly username?: string;
  /** `api` = read from GitLab, `manual` = entered by the user. */
  readonly expirySource: "api" | "manual";
  readonly verifiedAt: string;
  /** GitLab returned 401: stop calling this host until the token is updated. */
  readonly invalid?: boolean;
}

const META_KEY = "gitlabCiView.tokens";
const secretKey = (host: string) => `gitlabCiView.token/${host}`;

/** Tokens by host: values in SecretStorage, metadata in globalState. */
@injectable()
export class TokenStore {
  private readonly changed = new Emitter<string>();
  /** Emits the host whose token/metadata just changed. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly secrets = inject(SecretStore),
    private readonly state = inject(StateStore),
  ) {}

  hosts(): string[] {
    return Object.keys(this.all()).sort();
  }

  meta(host: string): TokenMeta | undefined {
    return this.all()[host];
  }

  token(host: string): Promise<string | undefined> {
    return this.secrets.get(secretKey(host));
  }

  async save(host: string, token: string, meta: TokenMeta): Promise<void> {
    await this.secrets.store(secretKey(host), token);
    await this.state.setGlobal(META_KEY, { ...this.all(), [host]: meta });
    this.changed.fire(host);
  }

  async updateMeta(host: string, patch: Partial<TokenMeta>): Promise<void> {
    const current = this.meta(host);
    if (!current) return;
    await this.state.setGlobal(META_KEY, { ...this.all(), [host]: { ...current, ...patch } });
    this.changed.fire(host);
  }

  async markInvalid(host: string): Promise<void> {
    if (this.meta(host)?.invalid) return;
    await this.updateMeta(host, { invalid: true });
  }

  async remove(host: string): Promise<void> {
    await this.secrets.delete(secretKey(host));
    const { [host]: _removed, ...rest } = this.all();
    await this.state.setGlobal(META_KEY, rest);
    this.changed.fire(host);
  }

  private all(): Readonly<Record<string, TokenMeta>> {
    return this.state.getGlobal<Record<string, TokenMeta>>(META_KEY) ?? {};
  }
}
