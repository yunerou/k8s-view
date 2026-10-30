import { AwsConfigSource } from "../../../src/app/ports/AwsConfigSource";
import { CredentialFile } from "../../../src/app/ports/CredentialFile";
import type { AwsCredentials } from "../../../src/core/aws/credentials";
import { parseIni } from "../../../src/core/aws/ini";

export class FakeConfigSource extends AwsConfigSource {
  constructor(
    public config = "",
    public credentials = "",
  ) {
    super();
  }
  async read() {
    return { config: parseIni(this.config), credentials: parseIni(this.credentials) };
  }
}

export class MemoryCredentialFile extends CredentialFile {
  readonly path = "/storage/credentials";
  readonly saved = new Map<string, AwsCredentials>();
  async read(profile: string) {
    return this.saved.get(profile);
  }
  async write(profile: string, credentials: AwsCredentials) {
    this.saved.set(profile, credentials);
  }
  async remove(profile: string) {
    this.saved.delete(profile);
  }
}

export function creds(accessKeyId: string, expiration?: Date): AwsCredentials {
  return { accessKeyId, secretAccessKey: "secret", ...(expiration ? { sessionToken: "token", expiration } : {}) };
}

import { AwsAuthApi, type SessionTokenInput } from "../../../src/app/ports/AwsAuthApi";

export class FakeAuthApi extends AwsAuthApi {
  readonly calls: string[] = [];
  resolveImpl: (profile: string, mfaCode: (serial: string) => Promise<string>) => Promise<AwsCredentials> = async (
    profile,
  ) => creds(`STATIC-${profile}`);
  sessionImpl: (base: AwsCredentials, input: SessionTokenInput) => Promise<AwsCredentials> = async () =>
    creds("SESSION", new Date(Date.now() + 3_600_000));

  resolve(profile: string, region: string, mfaCode: (serial: string) => Promise<string>) {
    this.calls.push(`resolve ${profile} ${region}`);
    return this.resolveImpl(profile, mfaCode);
  }
  getSessionToken(base: AwsCredentials, input: SessionTokenInput) {
    this.calls.push(`session ${base.accessKeyId} ${input.serialNumber} ${input.tokenCode} ${input.durationSeconds}`);
    return this.sessionImpl(base, input);
  }
}

import { AwsApi, type AwsTarget } from "../../../src/app/ports/AwsApi";
import type { Ec2Filter } from "../../../src/core/ec2/filters";
import type { Instance, SsmPing } from "../../../src/core/ec2/model";

export function instance(patch: Partial<Instance> & { readonly id: string }): Instance {
  return {
    name: undefined,
    type: "t3.large",
    state: "running",
    launchTime: undefined,
    imageId: "ami-1",
    platform: "Linux/UNIX",
    tags: {},
    ssm: undefined,
    ...patch,
  };
}

export class FakeAwsApi extends AwsApi {
  instances: Instance[] = [];
  pings = new Map<string, SsmPing>();
  imageNames = new Map<string, string>();
  readonly calls: string[] = [];
  readonly targets: AwsTarget[] = [];
  readonly filters: (readonly Ec2Filter[])[] = [];
  /** Runs before each describeInstances: lets a test move instances through states. */
  onDescribe: (() => void) | undefined;
  /** Replaces the default describeInstances result. */
  describeImpl: ((target: AwsTarget) => Promise<Instance[]>) | undefined;
  failWith: Error | undefined;

  async describeInstances(target: AwsTarget, filters: readonly Ec2Filter[], ids?: readonly string[]) {
    this.calls.push(`describe ${ids?.join(",") ?? "*"}`);
    this.targets.push(target);
    this.filters.push(filters);
    this.onDescribe?.();
    if (this.failWith) throw this.failWith;
    if (this.describeImpl) return this.describeImpl(target);
    return this.instances.filter((i) => !ids?.length || ids.includes(i.id)).map((i) => ({ ...i, ssm: undefined }));
  }
  async ssmPing(_target: AwsTarget, ids?: readonly string[]) {
    this.calls.push("ssm");
    return new Map([...this.pings].filter(([id]) => !ids?.length || ids.includes(id)));
  }
  async startInstance(_target: AwsTarget, id: string) {
    this.calls.push(`start ${id}`);
  }
  async stopInstance(target: AwsTarget, id: string) {
    this.calls.push(`stop ${id} ${target.region}`);
  }
  async createTags(_target: AwsTarget, id: string, tags: Readonly<Record<string, string>>) {
    this.calls.push(`createTags ${id} ${JSON.stringify(tags)}`);
    this.instances = this.instances.map((i) => (i.id === id ? { ...i, tags: { ...i.tags, ...tags } } : i));
  }
  async deleteTags(_target: AwsTarget, id: string, keys: readonly string[]) {
    this.calls.push(`deleteTags ${id} ${keys.join(",")}`);
    this.instances = this.instances.map((i) =>
      i.id === id ? { ...i, tags: Object.fromEntries(Object.entries(i.tags).filter(([k]) => !keys.includes(k))) } : i,
    );
  }
  async imageName(_target: AwsTarget, imageId: string) {
    this.calls.push(`image ${imageId}`);
    return this.imageNames.get(imageId);
  }
}

import { AuthService } from "../../../src/app/AuthService";
import { FakeNotifier, FakePrompter, FakeRunner, FakeSettings, FakeState } from "./fakes";

/** AuthService signed in to static profile `dev` (region `eu-west-1` unless `region` is null). */
export async function signedInAuth(
  options: { state?: FakeState; settings?: FakeSettings; region?: string | null } = {},
): Promise<AuthService> {
  const state = options.state ?? new FakeState();
  const region = options.region === undefined ? "eu-west-1" : options.region;
  await state.setGlobal("awsView.profile", "dev");
  const auth = new AuthService(
    new FakeConfigSource(
      region ? `[profile dev]\nregion = ${region}\n` : "[profile dev]\n",
      "[dev]\naws_access_key_id = A\naws_secret_access_key = S\n",
    ),
    new FakeAuthApi(),
    new MemoryCredentialFile(),
    state,
    options.settings ?? new FakeSettings(),
    new FakePrompter(),
    new FakeNotifier(),
    new FakeRunner(),
  );
  await auth.start();
  return auth;
}
