import type { AwsCredentials } from "../../core/aws/credentials";

export interface SessionTokenInput {
  readonly serialNumber: string;
  readonly tokenCode: string;
  readonly durationSeconds: number;
  readonly region: string;
}

/** Port: credential resolution (the AWS CLI's rules) and STS GetSessionToken. */
export abstract class AwsAuthApi {
  /** Static keys, assume role (nested `source_profile`) or SSO cache. `mfaCode` is called only when a role needs MFA. */
  abstract resolve(
    profile: string,
    region: string,
    mfaCode: (serial: string) => Promise<string>,
  ): Promise<AwsCredentials>;
  abstract getSessionToken(base: AwsCredentials, input: SessionTokenInput): Promise<AwsCredentials>;
}
