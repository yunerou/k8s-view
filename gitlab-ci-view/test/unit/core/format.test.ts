import { describe, expect, test } from "vitest";
import { formatAge, formatDuration } from "../../../src/core/util/format";

describe("format", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  test.each([
    ["2026-10-29T11:59:55Z", "5s ago"],
    ["2026-10-29T11:57:00Z", "3m ago"],
    ["2026-10-29T10:00:00Z", "2h ago"],
    ["2026-10-25T12:00:00Z", "4d ago"],
    ["2026-10-29T12:00:30Z", "just now"],
    ["garbage", ""],
  ])("age of %s", (iso, expected) => {
    expect(formatAge(iso, now)).toBe(expected);
  });

  test.each([
    [undefined, ""],
    [45.6, "45s"],
    [65, "1m 05s"],
    [3720, "1h 02m"],
  ])("duration %s", (s, expected) => {
    expect(formatDuration(s)).toBe(expected);
  });
});
