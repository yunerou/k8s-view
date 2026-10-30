/** Same shape as the SDK's `AwsCredentialIdentity`, so it can be passed to clients directly. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}
