import { errorMessage, isCanceled } from "../util/errors";

const field = (e: unknown, key: "name" | "code"): unknown =>
  typeof e === "object" && e !== null ? (e as Record<string, unknown>)[key] : undefined;

/** `ec2:StartInstances` from "… is not authorized to perform: ec2:StartInstances on resource …". */
export function missingPermission(e: unknown): string | undefined {
  return /not authorized to perform:?\s*([\w-]+:[\w*]+)/i.exec(errorMessage(e))?.[1];
}

export function isSsoExpired(e: unknown): boolean {
  const m = errorMessage(e);
  return /sso/i.test(m) && /(expired|invalid|refresh|sso login)/i.test(m);
}

export function isMfaFailure(e: unknown): boolean {
  return /multifactorauthentication failed|mfa one time pass code|invalid mfa/i.test(errorMessage(e));
}

export function isExpiredCredentials(e: unknown): boolean {
  const name = field(e, "name");
  return name === "ExpiredToken" || name === "ExpiredTokenException" || name === "RequestExpired";
}

/** One-line message for notifications and the tree. */
export function awsErrorMessage(e: unknown): string {
  if (isCanceled(e)) return "Canceled.";
  const permission = missingPermission(e);
  if (permission) return `Missing IAM permission: ${permission}.`;
  if (isExpiredCredentials(e)) return "AWS credentials have expired. Sign in again.";
  const code = field(e, "code");
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return `Cannot reach AWS (${code}). Check your network or proxy.`;
  }
  return errorMessage(e);
}
