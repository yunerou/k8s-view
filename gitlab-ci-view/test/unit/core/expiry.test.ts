import { describe, expect, test } from "vitest";
import { describeExpiry, expiryState, isValidDate } from "../../../src/core/auth/expiry";

const now = new Date("2026-10-29T15:00:00Z");

describe("expiryState", () => {
  test.each([
    [null, 7, { kind: "never" }],
    ["2026-12-01", 7, { kind: "ok", daysLeft: 33 }],
    ["2026-11-05", 7, { kind: "expiring", daysLeft: 7 }],
    ["2026-10-30", 0, { kind: "ok", daysLeft: 1 }],
    ["2026-10-29", 7, { kind: "expired" }],
    ["2026-01-01", 7, { kind: "expired" }],
  ])("%s (warn %d days)", (date, warn, expected) => {
    expect(expiryState(date, now, warn)).toEqual(expected);
  });

  test("describe", () => {
    expect(describeExpiry({ kind: "never" })).toBe("never expires");
    expect(describeExpiry({ kind: "expiring", daysLeft: 1 })).toBe("expires tomorrow");
    expect(describeExpiry({ kind: "ok", daysLeft: 33 })).toBe("expires in 33 days");
    expect(describeExpiry({ kind: "expired" })).toBe("has expired");
  });

  test("isValidDate", () => {
    expect(isValidDate("2027-02-28")).toBe(true);
    expect(isValidDate("2027-02-30")).toBe(false);
    expect(isValidDate("27-2-1")).toBe(false);
  });
});
