import { GetSessionTokenCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { injectable } from "@needle-di/core";
import { AwsAuthApi, type SessionTokenInput } from "../../app/ports/AwsAuthApi";
import type { AwsCredentials } from "../../core/aws/credentials";

@injectable()
export class SdkAuthApi extends AwsAuthApi {
  async resolve(
    profile: string,
    region: string,
    mfaCode: (serial: string) => Promise<string>,
  ): Promise<AwsCredentials> {
    // ignoreCache: re-read ~/.aws/* every time so edits and `aws sso login` are picked up.
    const c = await fromIni({ profile, mfaCodeProvider: mfaCode, ignoreCache: true, clientConfig: { region } })();
    return toCredentials(c.accessKeyId, c.secretAccessKey, c.sessionToken, c.expiration);
  }

  async getSessionToken(base: AwsCredentials, input: SessionTokenInput): Promise<AwsCredentials> {
    const sts = new STSClient({ region: input.region, credentials: base });
    try {
      const out = await sts.send(
        new GetSessionTokenCommand({
          SerialNumber: input.serialNumber,
          TokenCode: input.tokenCode,
          DurationSeconds: input.durationSeconds,
        }),
      );
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error("STS returned no credentials.");
      return toCredentials(c.AccessKeyId, c.SecretAccessKey, c.SessionToken, c.Expiration);
    } finally {
      sts.destroy();
    }
  }
}

function toCredentials(
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string | undefined,
  expiration: Date | undefined,
): AwsCredentials {
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(expiration ? { expiration } : {}),
  };
}
