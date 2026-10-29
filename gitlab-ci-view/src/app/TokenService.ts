import { inject, injectable } from "@needle-di/core";
import { z } from "zod";
import type { HostTarget } from "../core/remote/remote";
import { errorMessage } from "../core/util/errors";
import { GitLabApi, GitLabError } from "./ports/GitLabApi";

export type VerifyResult =
  | {
      readonly kind: "ok";
      readonly expiresAt: string | null;
      readonly scopes: readonly string[];
      readonly username: string;
    }
  /** The token works, but GitLab does not allow reading `expires_at`/scopes (older instance or non-PAT token). */
  | { readonly kind: "manual"; readonly username: string }
  | { readonly kind: "missingScope"; readonly scopes: readonly string[] }
  | { readonly kind: "invalid"; readonly message: string };

const userSchema = z.object({ username: z.string() });
const tokenSelfSchema = z.object({ scopes: z.array(z.string()), expires_at: z.string().nullable() });

@injectable()
export class TokenService {
  constructor(private readonly api = inject(GitLabApi)) {}

  async verify(target: HostTarget, token: string): Promise<VerifyResult> {
    let username: string;
    try {
      username = (await this.api.get(target, "/user", {}, userSchema, { token })).data.username;
    } catch (e) {
      return { kind: "invalid", message: errorMessage(e) };
    }
    try {
      const self = (await this.api.get(target, "/personal_access_tokens/self", {}, tokenSelfSchema, { token })).data;
      if (!self.scopes.includes("api")) return { kind: "missingScope", scopes: self.scopes };
      return { kind: "ok", expiresAt: self.expires_at, scopes: self.scopes, username };
    } catch (e) {
      if (e instanceof GitLabError && (e.kind === "notFound" || e.kind === "unauthorized" || e.kind === "forbidden")) {
        return { kind: "manual", username };
      }
      return { kind: "invalid", message: errorMessage(e) };
    }
  }
}
