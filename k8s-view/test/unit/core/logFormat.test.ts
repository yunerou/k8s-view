import { describe, expect, test } from "vitest";
import {
  colorFor,
  formatLogLine,
  formatNotice,
  highlightLine,
  LineBuffer,
  stripAnsi,
} from "../../../src/core/logs/LogFormat";

describe("LineBuffer", () => {
  test("emits complete lines and keeps the partial one", () => {
    const b = new LineBuffer();
    expect(b.push("a\nb")).toEqual(["a"]);
    expect(b.push("c\r\nd\n")).toEqual(["bc", "d"]);
    expect(b.push("tail")).toEqual([]);
    expect(b.flush()).toEqual(["tail"]);
    expect(b.flush()).toEqual([]);
  });
});

describe("formatLogLine", () => {
  test("colored prefix, stable per source", () => {
    const line = formatLogLine("hello", { prefix: "web-1/app" });
    expect(stripAnsi(line)).toBe("web-1/app hello");
    expect(line).toContain(`\x1b[${colorFor("web-1/app")}m`);
    expect(colorFor("web-1/app")).toBe(colorFor("web-1/app"));
    expect(formatLogLine("hello")).toBe("hello");
  });

  test("highlights only the first level keyword and dims the timestamp", () => {
    const line = highlightLine("2026-10-22T10:00:00.123Z ERROR failed: error again");
    expect(stripAnsi(line)).toBe("2026-10-22T10:00:00.123Z ERROR failed: error again");
    expect(line).toContain("\x1b[2m2026-10-22T10:00:00.123Z\x1b[0m");
    expect(line).toContain("\x1b[1;31mERROR\x1b[0m");
    expect(line.split("\x1b[1;31m")).toHaveLength(2);
    expect(highlightLine('{"level":"warn","msg":"x"}')).toContain("\x1b[1;33mwarn\x1b[0m");
    expect(highlightLine("plain line")).toBe("plain line");
  });

  test("lines already colored by the app and highlight=false are untouched", () => {
    expect(highlightLine("\x1b[31mred\x1b[0m ERROR")).toBe("\x1b[31mred\x1b[0m ERROR");
    expect(formatLogLine("ERROR x", { highlight: false })).toBe("ERROR x");
  });

  test("notice is dimmed with a marker", () => {
    expect(stripAnsi(formatNotice("pod gone", "-"))).toBe("- pod gone");
  });
});
