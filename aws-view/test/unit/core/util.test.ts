import { afterEach, describe, expect, test, vi } from "vitest";
import { CanceledError, errorMessage, isCanceled } from "../../../src/core/util/errors";
import { formatDuration } from "../../../src/core/util/format";
import { expandHome } from "../../../src/core/util/paths";
import { sleep } from "../../../src/core/util/sleep";

afterEach(() => vi.useRealTimers());

describe("errors", () => {
  test("messages and cancellation", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("text")).toBe("text");
    expect(isCanceled(new CanceledError())).toBe(true);
    expect(isCanceled(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isCanceled(new Error("x"))).toBe(false);
    expect(isCanceled(undefined)).toBe(false);
  });
});

describe("sleep", () => {
  test("resolves after the delay and rejects when aborted", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void sleep(1000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CanceledError);
    await expect(sleep(10, controller.signal)).rejects.toBeInstanceOf(CanceledError);
  });
});

describe("paths and format", () => {
  test("expandHome", () => {
    expect(expandHome("~", "/Users/a")).toBe("/Users/a");
    expect(expandHome("~/.ssh/x", "/Users/a")).toBe("/Users/a/.ssh/x");
    expect(expandHome("/etc/x", "/Users/a")).toBe("/etc/x");
    expect(expandHome("~other/x", "/Users/a")).toBe("~other/x");
  });

  test("formatDuration", () => {
    expect(formatDuration(20_000)).toBe("<1m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000)).toBe("3d 4h");
    expect(formatDuration(-5)).toBe("<1m");
  });
});
