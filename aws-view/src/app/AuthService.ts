import { inject, injectable } from "@needle-di/core";
import type { AwsCredentials } from "../core/aws/credentials";
import { isMfaFailure, isSsoExpired } from "../core/aws/errors";
import { type AwsProfile, parseProfiles, sessionProfileName, usesSessionFile } from "../core/aws/profiles";
import { type Disposable, Emitter } from "../core/util/Emitter";
import { CanceledError } from "../core/util/errors";
import { AwsAuthApi } from "./ports/AwsAuthApi";
import { AwsConfigSource } from "./ports/AwsConfigSource";
import { CredentialFile } from "./ports/CredentialFile";
import { Notifier } from "./ports/Notifier";
import { Prompter } from "./ports/Prompter";
import { Runner } from "./ports/Runner";
import { Settings } from "./ports/Settings";
import { StateStore } from "./ports/StateStore";

const PROFILE_KEY = "awsView.profile";
const MAX_MFA_ATTEMPTS = 3;
const DEFAULT_SESSION_SECONDS = 43_200;
/** Credentials closer than this to their expiration are treated as expired. */
const EXPIRY_MARGIN_MS = 60_000;

export type AuthState =
  | { readonly status: "noProfile" }
  | { readonly status: "signedOut"; readonly profile: AwsProfile }
  | { readonly status: "signedIn"; readonly profile: AwsProfile; readonly expiresAt: number | undefined };

const noMfa = (): Promise<string> => Promise.reject(new CanceledError());

/** Selected profile and its credentials; MFA/role sessions are shared with the AWS CLI and other windows via a file. */
@injectable()
export class AuthService implements Disposable {
  private readonly changed = new Emitter<AuthState>();
  readonly onDidChange = this.changed.event;
  private all: readonly AwsProfile[] = [];
  private current: AwsProfile | undefined;
  private cached: AwsCredentials | undefined;
  private generation = 0;
  /** Sign-in in flight: concurrent callers wait for it instead of asking for MFA again. */
  private signingIn: Promise<AwsCredentials> | undefined;

  constructor(
    private readonly configSource = inject(AwsConfigSource),
    private readonly api = inject(AwsAuthApi),
    private readonly file = inject(CredentialFile),
    private readonly store = inject(StateStore),
    private readonly settings = inject(Settings),
    private readonly prompter = inject(Prompter),
    private readonly notifier = inject(Notifier),
    private readonly runner = inject(Runner),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Load profiles and restore the last profile without prompting. */
  async start(): Promise<void> {
    await this.loadProfiles();
    const saved = this.store.getGlobal<string>(PROFILE_KEY);
    this.current = this.all.find((p) => p.name === saved);
    await this.restore();
    this.changed.fire(this.state());
  }

  async loadProfiles(): Promise<readonly AwsProfile[]> {
    const files = await this.configSource.read();
    this.all = parseProfiles(files.config, files.credentials);
    return this.all;
  }

  profiles(): readonly AwsProfile[] {
    return this.all;
  }

  profile(): AwsProfile | undefined {
    return this.current;
  }

  state(): AuthState {
    if (!this.current) return { status: "noProfile" };
    if (!this.isValid(this.cached)) return { status: "signedOut", profile: this.current };
    return { status: "signedIn", profile: this.current, expiresAt: this.cached.expiration?.getTime() };
  }

  /** Valid credentials in memory; never prompts. */
  isSignedIn(): boolean {
    return this.isValid(this.cached);
  }

  async selectProfile(name: string): Promise<void> {
    const profile = this.all.find((p) => p.name === name);
    if (!profile) throw new Error(`AWS profile "${name}" not found.`);
    this.generation++;
    this.current = profile;
    this.cached = undefined;
    this.signingIn = undefined;
    await this.store.setGlobal(PROFILE_KEY, name);
    await this.restore();
    this.changed.fire(this.state());
  }

  /** Credentials for SDK calls: cached, or a fresh sign-in (may prompt for MFA or open the SSO login). */
  async credentials(): Promise<AwsCredentials> {
    return this.isValid(this.cached) ? this.cached : this.signIn();
  }

  signIn(): Promise<AwsCredentials> {
    if (!this.signingIn) {
      const pending = this.doSignIn().finally(() => {
        if (this.signingIn === pending) this.signingIn = undefined;
      });
      this.signingIn = pending;
    }
    return this.signingIn;
  }

  async signOut(): Promise<void> {
    const p = this.current;
    if (!p) return;
    this.generation++;
    this.signingIn = undefined;
    this.cached = undefined;
    if (usesSessionFile(p.kind)) await this.file.remove(sessionProfileName(p.name));
    this.changed.fire(this.state());
  }

  /** Environment for AWS CLI processes (ProxyCommand, SSM terminal). */
  cliEnv(region: string): Record<string, string> {
    const p = this.current;
    if (!p) throw new Error("Select an AWS profile first.");
    return usesSessionFile(p.kind)
      ? { AWS_PROFILE: sessionProfileName(p.name), AWS_REGION: region, AWS_SHARED_CREDENTIALS_FILE: this.file.path }
      : { AWS_PROFILE: p.name, AWS_REGION: region };
  }

  dispose(): void {
    this.changed.dispose();
  }

  private isValid(c: AwsCredentials | undefined): c is AwsCredentials {
    return c !== undefined && (!c.expiration || c.expiration.getTime() - EXPIRY_MARGIN_MS > this.now());
  }

  private stsRegion(p: AwsProfile): string {
    return p.region ?? this.settings.regions()[0] ?? "us-east-1";
  }

  /** Without prompting: the shared session file (MFA/role), or a silent resolution (static keys, SSO cache). */
  private async restore(): Promise<void> {
    const p = this.current;
    const generation = this.generation;
    this.cached = undefined;
    if (!p) return;
    try {
      if (usesSessionFile(p.kind)) {
        const saved = await this.file.read(sessionProfileName(p.name));
        if (generation === this.generation && this.isValid(saved)) this.cached = saved;
      } else {
        const credentials = await this.api.resolve(p.name, this.stsRegion(p), noMfa);
        if (generation === this.generation) this.cached = credentials;
      }
    } catch {
      if (generation === this.generation) this.cached = undefined;
    }
  }

  private async doSignIn(): Promise<AwsCredentials> {
    const generation = this.generation;
    const p = this.current;
    if (!p) throw new Error("Select an AWS profile first.");
    // Another window may have signed in already.
    if (usesSessionFile(p.kind)) {
      const saved = await this.file.read(sessionProfileName(p.name));
      if (this.isValid(saved)) return this.accept(p, saved, generation);
    }
    const credentials = await this.resolveInteractive(p);
    if (this.generation !== generation) throw new CanceledError();
    if (usesSessionFile(p.kind)) await this.file.write(sessionProfileName(p.name), credentials);
    return this.accept(p, credentials, generation);
  }

  private accept(p: AwsProfile, c: AwsCredentials, generation: number): AwsCredentials {
    // The user switched profile while this sign-in was running.
    if (this.current !== p || generation !== this.generation) throw new CanceledError();
    this.cached = c;
    this.changed.fire(this.state());
    return c;
  }

  private async resolveInteractive(p: AwsProfile): Promise<AwsCredentials> {
    const region = this.stsRegion(p);
    switch (p.kind) {
      case "static":
        return this.api.resolve(p.name, region, noMfa);
      case "sso":
        return this.resolveSso(p, region);
      case "assumeRole":
        return this.withMfaRetries(p, (mfaCode) => this.api.resolve(p.name, region, mfaCode));
      case "staticMfa": {
        const base = await this.api.resolve(p.name, region, noMfa);
        const serialNumber = p.mfaSerial!;
        return this.withMfaRetries(p, async (mfaCode) =>
          this.api.getSessionToken(base, {
            serialNumber,
            tokenCode: await mfaCode(serialNumber),
            durationSeconds: p.durationSeconds ?? DEFAULT_SESSION_SECONDS,
            region,
          }),
        );
      }
    }
  }

  private async withMfaRetries(
    p: AwsProfile,
    attempt: (mfaCode: (serial: string) => Promise<string>) => Promise<AwsCredentials>,
  ): Promise<AwsCredentials> {
    for (let i = 1; ; i++) {
      try {
        return await attempt((serial) => this.askMfa(p, serial, i > 1));
      } catch (e) {
        if (!isMfaFailure(e) || i >= MAX_MFA_ATTEMPTS) throw e;
      }
    }
  }

  private async askMfa(p: AwsProfile, serial: string, retry: boolean): Promise<string> {
    const code = await this.prompter.input({
      title: `MFA code for ${p.name}`,
      prompt: retry
        ? `The previous code was rejected. Enter a new code for ${serial}`
        : `Enter the 6-digit code for ${serial}`,
      placeholder: "123456",
      validate: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : "Enter the 6 digits shown by your MFA device"),
    });
    if (code === undefined) throw new CanceledError();
    return code.trim();
  }

  private async resolveSso(p: AwsProfile, region: string): Promise<AwsCredentials> {
    try {
      return await this.api.resolve(p.name, region, noMfa);
    } catch (e) {
      if (!isSsoExpired(e)) throw e;
    }
    await this.notifier.progress(`Signing in to ${p.name} with AWS SSO (finish in your browser)…`, async (signal) => {
      const r = await this.runner.run(this.settings.awsCliPath(), ["sso", "login", "--profile", p.name], { signal });
      if (r.code !== 0) {
        throw new Error(`aws sso login failed: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
      }
    });
    return this.api.resolve(p.name, region, noMfa);
  }
}
