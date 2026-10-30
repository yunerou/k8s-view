import { describe, expect, test } from "vitest";
import {
  awsErrorMessage,
  isExpiredCredentials,
  isMfaFailure,
  isSsoExpired,
  missingPermission,
} from "../../../src/core/aws/errors";
import { CanceledError } from "../../../src/core/util/errors";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe("AWS errors", () => {
  test("missing permission is extracted from the authorization message", () => {
    const e = named(
      "UnauthorizedOperation",
      "You are not authorized to perform this operation. User: arn:aws:iam::1:user/a is not authorized to perform: ec2:StartInstances on resource: arn:aws:ec2:eu-west-1:1:instance/i-1",
    );
    expect(missingPermission(e)).toBe("ec2:StartInstances");
    expect(awsErrorMessage(e)).toBe("Missing IAM permission: ec2:StartInstances.");
  });

  test("SSO, MFA and expiry detection", () => {
    expect(
      isSsoExpired(new Error("The SSO session associated with this profile has expired or is otherwise invalid.")),
    ).toBe(true);
    expect(isSsoExpired(new Error("Token is expired"))).toBe(false);
    expect(
      isMfaFailure(named("AccessDenied", "MultiFactorAuthentication failed with invalid MFA one time pass code.")),
    ).toBe(true);
    expect(isMfaFailure(new Error("other"))).toBe(false);
    expect(isExpiredCredentials(named("ExpiredToken", "x"))).toBe(true);
    expect(awsErrorMessage(named("ExpiredTokenException", "x"))).toBe("AWS credentials have expired. Sign in again.");
  });

  test("network, cancel and fallback messages", () => {
    expect(awsErrorMessage(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }))).toBe(
      "Cannot reach AWS (ENOTFOUND). Check your network or proxy.",
    );
    expect(awsErrorMessage(new CanceledError())).toBe("Canceled.");
    expect(awsErrorMessage(new Error("Something else"))).toBe("Something else");
  });
});
