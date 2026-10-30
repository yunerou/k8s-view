import type { AwsCredentials } from "../../core/aws/credentials";

/** Port: the extension's own credentials file (temporary MFA/role sessions), shared with the AWS CLI. */
export abstract class CredentialFile {
  /** Absolute path, given to the AWS CLI through `AWS_SHARED_CREDENTIALS_FILE`. */
  abstract readonly path: string;
  abstract read(profile: string): Promise<AwsCredentials | undefined>;
  abstract write(profile: string, credentials: AwsCredentials): Promise<void>;
  abstract remove(profile: string): Promise<void>;
}
