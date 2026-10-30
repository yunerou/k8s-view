export interface ReminderRecord {
  /** No reminder before this time (shown or snoozed). */
  readonly nextAt?: number;
  /** "Not today". */
  readonly mutedUntil?: number;
}

export function reminderDue(uptimeMs: number, hours: number, now: number, record: ReminderRecord | undefined): boolean {
  return uptimeMs >= hours * 3_600_000 && now >= (record?.nextAt ?? 0) && now >= (record?.mutedUntil ?? 0);
}

/** Next local midnight after `now`. */
export function nextMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
