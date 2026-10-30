import { describe, expect, test } from "vitest";
import { nextMidnight, reminderDue } from "../../../src/core/reminder";

const HOUR = 3_600_000;

describe("reminder", () => {
  test("due after the configured hours, unless snoozed or muted", () => {
    const now = 1_000 * HOUR;
    expect(reminderDue(4 * HOUR, 4, now, undefined)).toBe(true);
    expect(reminderDue(4 * HOUR - 1, 4, now, undefined)).toBe(false);
    expect(reminderDue(5 * HOUR, 4, now, { nextAt: now + 1 })).toBe(false);
    expect(reminderDue(5 * HOUR, 4, now, { nextAt: now })).toBe(true);
    expect(reminderDue(5 * HOUR, 4, now, { mutedUntil: now + 1 })).toBe(false);
    expect(reminderDue(0.06 * HOUR, 0.05, now, {})).toBe(true);
  });

  test("next local midnight", () => {
    const d = new Date(nextMidnight(new Date(2026, 9, 30, 15, 30).getTime()));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 31, 0, 0]);
  });
});
