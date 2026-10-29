export type ExpiryState =
  | { readonly kind: "never" }
  | { readonly kind: "ok"; readonly daysLeft: number }
  | { readonly kind: "expiring"; readonly daysLeft: number }
  | { readonly kind: "expired" };

const DAY_MS = 86_400_000;

/** GitLab: tokens expire at 00:00 UTC on `expiresAt`. */
export function expiryState(expiresAt: string | null, now: Date, warnDays: number): ExpiryState {
  if (expiresAt === null) return { kind: "never" };
  const end = Date.parse(`${expiresAt}T00:00:00Z`);
  if (Number.isNaN(end)) return { kind: "never" };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysLeft = Math.round((end - today) / DAY_MS);
  if (daysLeft <= 0) return { kind: "expired" };
  return daysLeft <= warnDays ? { kind: "expiring", daysLeft } : { kind: "ok", daysLeft };
}

export function describeExpiry(state: ExpiryState): string {
  switch (state.kind) {
    case "never":
      return "never expires";
    case "expired":
      return "has expired";
    default:
      return state.daysLeft === 1 ? "expires tomorrow" : `expires in ${state.daysLeft} days`;
  }
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(value);
}
