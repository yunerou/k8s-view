import { inject, injectable } from "@needle-di/core";
import { describeExpiry, expiryState, isValidDate } from "../core/auth/expiry";
import { type HostTarget, hostTarget } from "../core/remote/remote";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import { Settings } from "./ports/Settings";
import { TokenService } from "./TokenService";
import { TokenStore } from "./TokenStore";

/** "Set GitLab token" and "Manage GitLab tokens" workflows. */
@injectable()
export class TokenFlow {
  constructor(
    private readonly tokens = inject(TokenService),
    private readonly store = inject(TokenStore),
    private readonly settings = inject(Settings),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `choices`: hosts detected from workspace remotes. Returns `true` when a token is saved. */
  async setToken(choices: readonly HostTarget[], preset?: HostTarget): Promise<boolean> {
    const target = preset ?? (await this.pickHost(choices));
    if (!target) return false;
    const raw = await this.prompter.input({
      title: `GitLab token for ${target.host}`,
      prompt: "Personal access token with the api scope",
      placeholder: "glpat-…",
      password: true,
      validate: (v) => (v.trim() ? undefined : "The token is required"),
    });
    const token = raw?.trim();
    if (!token) return false;
    const result = await this.tokens.verify(target, token);
    const verifiedAt = this.now().toISOString();
    switch (result.kind) {
      case "invalid":
        await this.notifier.error(`Could not verify the GitLab token for ${target.host}: ${result.message}`);
        return false;
      case "missingScope":
        await this.notifier.error(
          `The token for ${target.host} lacks the "api" scope (it has: ${result.scopes.join(", ") || "none"}).`,
        );
        return false;
      case "ok":
        await this.store.save(target.host, token, {
          expiresAt: result.expiresAt,
          scopes: result.scopes,
          username: result.username,
          expirySource: "api",
          verifiedAt,
        });
        void this.notifier.info(`GitLab token saved for ${target.host} (${this.expiryText(result.expiresAt)}).`);
        return true;
      case "manual": {
        const expiresAt = await this.askExpiry(target.host);
        if (expiresAt === undefined) return false;
        await this.store.save(target.host, token, {
          expiresAt,
          scopes: [],
          username: result.username,
          expirySource: "manual",
          verifiedAt,
        });
        void this.notifier.info(
          `GitLab token saved for ${target.host}. GitLab did not report its scopes: make sure it has the "api" scope.`,
        );
        return true;
      }
    }
  }

  async manage(choices: readonly HostTarget[]): Promise<void> {
    const hosts = this.store.hosts();
    if (hosts.length === 0) {
      if (await this.notifier.info("No GitLab token saved yet.", "Set token")) await this.setToken(choices);
      return;
    }
    const host = await this.prompter.pick(
      hosts.map((h) => ({ label: h, description: this.describe(h), value: h })),
      { title: "GitLab tokens" },
    );
    if (!host) return;
    const action = await this.prompter.pick<"update" | "expiry" | "remove">(
      [
        { label: "$(key) Update token…", value: "update" },
        { label: "$(calendar) Change expiry date…", value: "expiry" },
        { label: "$(trash) Remove token", value: "remove" },
      ],
      { title: host },
    );
    if (action === "update") {
      await this.setToken(choices, choices.find((c) => c.host === host) ?? hostTarget(host, this.settings.hosts()));
    } else if (action === "expiry") {
      const expiresAt = await this.askExpiry(host, this.store.meta(host)?.expiresAt ?? undefined);
      if (expiresAt !== undefined) await this.store.updateMeta(host, { expiresAt, expirySource: "manual" });
    } else if (action === "remove") {
      if ((await this.notifier.warn(`Remove the GitLab token for ${host}?`, "Remove")) === "Remove") {
        await this.store.remove(host);
      }
    }
  }

  /** Short host description: token expiration and owner. */
  describe(host: string): string {
    const meta = this.store.meta(host);
    if (!meta) return "no token";
    if (meta.invalid) return "rejected by GitLab, update it";
    return `${this.expiryText(meta.expiresAt)}${meta.username ? ` · @${meta.username}` : ""}`;
  }

  private expiryText(expiresAt: string | null): string {
    return describeExpiry(expiryState(expiresAt, this.now(), this.settings.tokenExpiryWarningDays()));
  }

  private async pickHost(choices: readonly HostTarget[]): Promise<HostTarget | undefined> {
    const picked = await this.prompter.pick<HostTarget | null>(
      [
        ...choices.map((c) => ({ label: c.host, description: this.describe(c.host), detail: c.apiUrl, value: c })),
        { label: "$(add) Other host…", value: null },
      ],
      { title: "Set GitLab token", placeholder: "GitLab instance" },
    );
    if (picked !== null) return picked;
    const host = await this.prompter.input({
      title: "Set GitLab token",
      prompt: "Host name of the GitLab instance",
      placeholder: "git.company.vn",
      validate: (v) =>
        /^[a-z0-9.-]+(:\d+)?$/i.test(v.trim()) ? undefined : "Enter a host name such as git.company.vn",
    });
    return host ? hostTarget(host.trim(), this.settings.hosts()) : undefined;
  }

  /** `null` = never expires, `undefined` = canceled. */
  private async askExpiry(host: string, current?: string): Promise<string | null | undefined> {
    const choice = await this.prompter.pick<"date" | "never">(
      [
        { label: "$(calendar) Enter expiry date…", value: "date" },
        { label: "Never expires", value: "never" },
      ],
      { title: `Expiry date of the token for ${host}`, placeholder: "GitLab did not report the expiry date" },
    );
    if (!choice) return undefined;
    if (choice === "never") return null;
    const value = await this.prompter.input({
      title: `Expiry date of the token for ${host}`,
      prompt: "YYYY-MM-DD",
      ...(current ? { value: current } : {}),
      validate: (v) => (isValidDate(v.trim()) ? undefined : "Use the format YYYY-MM-DD"),
    });
    return value === undefined ? undefined : value.trim();
  }
}
