import { GetSessionTokenCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SdkAuthApi } from "../../../src/infra/aws/SdkAuthApi";

const { fromIni } = vi.hoisted(() => ({ fromIni: vi.fn() }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromIni }));

const sts = mockClient(STSClient);
afterEach(() => {
  sts.reset();
  fromIni.mockReset();
});

describe("SdkAuthApi", () => {
  test("resolve delegates to fromIni with the MFA callback", async () => {
    const expiration = new Date("2026-10-30T10:00:00Z");
    fromIni.mockReturnValue(async () => ({ accessKeyId: "A", secretAccessKey: "S", sessionToken: "T", expiration }));
    const mfa = async () => "123456";
    const c = await new SdkAuthApi().resolve("admin", "eu-west-1", mfa);
    expect(fromIni).toHaveBeenCalledWith({
      profile: "admin",
      mfaCodeProvider: mfa,
      ignoreCache: true,
      clientConfig: { region: "eu-west-1" },
    });
    expect(c).toEqual({ accessKeyId: "A", secretAccessKey: "S", sessionToken: "T", expiration });
  });

  test("getSessionToken sends serial, code and duration", async () => {
    sts.on(GetSessionTokenCommand).resolves({
      Credentials: {
        AccessKeyId: "AS",
        SecretAccessKey: "SS",
        SessionToken: "TT",
        Expiration: new Date("2026-10-30T20:00:00Z"),
      },
    });
    const c = await new SdkAuthApi().getSessionToken(
      { accessKeyId: "A", secretAccessKey: "S" },
      { serialNumber: "arn:mfa", tokenCode: "123456", durationSeconds: 3600, region: "eu-west-1" },
    );
    expect(sts.commandCalls(GetSessionTokenCommand)[0]?.args[0].input).toEqual({
      SerialNumber: "arn:mfa",
      TokenCode: "123456",
      DurationSeconds: 3600,
    });
    expect(c).toEqual({
      accessKeyId: "AS",
      secretAccessKey: "SS",
      sessionToken: "TT",
      expiration: new Date("2026-10-30T20:00:00Z"),
    });
  });
});
