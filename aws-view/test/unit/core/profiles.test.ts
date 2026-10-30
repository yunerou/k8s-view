import { describe, expect, test } from "vitest";
import { parseIni } from "../../../src/core/aws/ini";
import { kindLabel, parseProfiles, sessionProfileName, usesSessionFile } from "../../../src/core/aws/profiles";

const config = parseIni(`
[default]
region = eu-west-1

[profile dev-mfa]
mfa_serial = arn:aws:iam::1:mfa/dev
duration_seconds = 3600

[profile admin]
role_arn = arn:aws:iam::1:role/Admin
source_profile = dev-mfa
mfa_serial = arn:aws:iam::1:mfa/dev

[profile corp]
sso_session = corp
sso_account_id = 1
region = ap-southeast-1

[profile legacy-sso]
sso_start_url = https://x.awsapps.com/start

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
`);
const credentials = parseIni(`
[default]
aws_access_key_id = A
aws_secret_access_key = S

[only-creds]
aws_access_key_id = B
aws_secret_access_key = T
mfa_serial = arn:aws:iam::1:mfa/creds
`);

describe("parseProfiles", () => {
  test("classifies every profile from both files, default first", () => {
    expect(parseProfiles(config, credentials)).toEqual([
      { name: "default", kind: "static", region: "eu-west-1", mfaSerial: undefined, durationSeconds: undefined },
      {
        name: "admin",
        kind: "assumeRole",
        region: undefined,
        mfaSerial: "arn:aws:iam::1:mfa/dev",
        durationSeconds: undefined,
      },
      { name: "corp", kind: "sso", region: "ap-southeast-1", mfaSerial: undefined, durationSeconds: undefined },
      {
        name: "dev-mfa",
        kind: "staticMfa",
        region: undefined,
        mfaSerial: "arn:aws:iam::1:mfa/dev",
        durationSeconds: 3600,
      },
      { name: "legacy-sso", kind: "sso", region: undefined, mfaSerial: undefined, durationSeconds: undefined },
      {
        name: "only-creds",
        kind: "staticMfa",
        region: undefined,
        mfaSerial: "arn:aws:iam::1:mfa/creds",
        durationSeconds: undefined,
      },
    ]);
  });

  test("sso-session sections are not profiles; empty files give no profiles", () => {
    expect(parseProfiles(config, {}).map((p) => p.name)).toEqual(["default", "admin", "corp", "dev-mfa", "legacy-sso"]);
    expect(parseProfiles({}, {})).toEqual([]);
  });

  test("helpers", () => {
    expect(sessionProfileName("dev")).toBe("dev-aws-view");
    expect(["static", "staticMfa", "assumeRole", "sso"].map((k) => usesSessionFile(k as never))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(kindLabel("staticMfa")).toBe("access key + MFA");
  });
});
