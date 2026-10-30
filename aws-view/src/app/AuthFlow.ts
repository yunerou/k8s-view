import { inject, injectable } from "@needle-di/core";
import { awsErrorMessage } from "../core/aws/errors";
import { kindLabel } from "../core/aws/profiles";
import { isCanceled } from "../core/util/errors";
import { AuthService } from "./AuthService";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";

/** Commands around the profile: pick it, sign in, sign out. */
@injectable()
export class AuthFlow {
  constructor(
    private readonly auth = inject(AuthService),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
  ) {}

  async selectProfile(): Promise<void> {
    await this.report(async () => {
      const profiles = await this.auth.loadProfiles();
      if (profiles.length === 0) {
        await this.notifier.warn(
          "No AWS profiles found in ~/.aws/config or ~/.aws/credentials. Run `aws configure` or `aws configure sso` first.",
        );
        return;
      }
      const current = this.auth.profile()?.name;
      const name = await this.prompter.pick(
        profiles.map((p) => ({
          label: p.name === current ? `$(check) ${p.name}` : p.name,
          description: [kindLabel(p.kind), p.region].filter(Boolean).join(" · "),
          value: p.name,
        })),
        { title: "AWS profile", placeholder: "Profile from ~/.aws/config" },
      );
      if (name === undefined) return;
      await this.auth.selectProfile(name);
      if (!this.auth.isSignedIn()) await this.auth.signIn();
    });
  }

  async signIn(): Promise<void> {
    if (!this.auth.profile()) return this.selectProfile();
    await this.report(() => this.auth.signIn());
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
  }

  private async report(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (e) {
      if (!isCanceled(e)) await this.notifier.error(awsErrorMessage(e));
    }
  }
}
