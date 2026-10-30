import type { IniSections } from "./ini";

export type ProfileKind = "static" | "staticMfa" | "assumeRole" | "sso";

export interface AwsProfile {
  readonly name: string;
  readonly kind: ProfileKind;
  readonly region: string | undefined;
  readonly mfaSerial: string | undefined;
  readonly durationSeconds: number | undefined;
}

/** Profiles from `~/.aws/config` (`[default]`, `[profile x]`) and `~/.aws/credentials` (`[x]`); credentials win on conflicts. */
export function parseProfiles(config: IniSections, credentials: IniSections): AwsProfile[] {
  const names = new Set<string>();
  for (const section of Object.keys(config)) {
    if (section === "default") names.add("default");
    else if (section.startsWith("profile ")) names.add(section.slice("profile ".length).trim());
  }
  for (const section of Object.keys(credentials)) names.add(section);
  return [...names]
    .map((name) =>
      toProfile(name, { ...config[name === "default" ? "default" : `profile ${name}`], ...credentials[name] }),
    )
    .sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name)));
}

function toProfile(name: string, v: Readonly<Record<string, string>>): AwsProfile {
  const kind: ProfileKind =
    v["sso_session"] || v["sso_start_url"] || v["sso_account_id"]
      ? "sso"
      : v["role_arn"]
        ? "assumeRole"
        : v["mfa_serial"]
          ? "staticMfa"
          : "static";
  const duration = Number.parseInt(v["duration_seconds"] ?? "", 10);
  return {
    name,
    kind,
    region: v["region"] || undefined,
    mfaSerial: v["mfa_serial"] || undefined,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
  };
}

/** Profile holding the temporary credentials the extension writes to its own credentials file. */
export function sessionProfileName(name: string): string {
  return `${name}-aws-view`;
}

/** MFA and assume-role credentials are resolved by the extension, then shared with the AWS CLI through a file. */
export function usesSessionFile(kind: ProfileKind): boolean {
  return kind === "staticMfa" || kind === "assumeRole";
}

const KIND_LABELS: Record<ProfileKind, string> = {
  static: "access key",
  staticMfa: "access key + MFA",
  assumeRole: "assume role",
  sso: "SSO",
};

export function kindLabel(kind: ProfileKind): string {
  return KIND_LABELS[kind];
}
