import { expect, it } from "vitest";
import { cleanLog, sliceLog } from "../../../../src/app/mcp/logText";

it("cleans ANSI, OSC, section markers and carriage returns without losing Unicode", () => {
  expect(
    cleanLog(
      "\x1b[31mred\x1b[0m\r\nsection_start:123:build[collapsed=true]\r\x1b[0KViệt\nsection_end:124:build\r\x1b[0K\n",
    ),
  ).toEqual(["red", "Việt", ""]);
  expect(cleanLog("")).toEqual([]);
  expect(cleanLog("hello\n")).toEqual(["hello"]);
});
it("slices tail and 1-based ranges, with empty bounds and continuation hints", () => {
  const lines = Array.from({ length: 300 }, (_, i) => String(i + 1));
  expect(sliceLog(lines)).toMatchObject({ fromLine: 101, toLine: 300, truncated: false });
  expect(sliceLog(lines, { offset: 3, limit: 2 })).toMatchObject({
    text: "3\n4",
    fromLine: 3,
    toLine: 4,
    truncated: true,
    hint: expect.stringContaining("offset=5"),
  });
  expect(sliceLog([], {})).toMatchObject({ totalLines: 0, fromLine: 0, toLine: 0, text: "" });
  expect(sliceLog(lines, { offset: 1000 })).toMatchObject({ fromLine: 0, toLine: 0, text: "" });
});
it("merges grep windows and limits matches", () => {
  expect(sliceLog(["a", "match", "match", "b", "c"], { grep: "match", context: 1 })).toMatchObject({
    text: "1: a\n2: match\n3: match\n4: b",
    truncated: false,
  });
  expect(sliceLog(Array(100).fill("match"), { grep: "match", context: 0 })).toMatchObject({
    toLine: 50,
    truncated: true,
  });
});
it("caps lines and UTF-8 bytes without breaking code points", () => {
  expect(sliceLog(Array(4000).fill("x"), { tail: 4000 })).toMatchObject({ toLine: 2000, truncated: true });
  const result = sliceLog(["😺".repeat(100000)], { tail: 1 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(200 * 1024);
  expect(result.text.endsWith("😺")).toBe(true);
  expect(result.text).not.toContain("�");
  expect(result.truncated).toBe(true);
});
it.each([
  { tail: 1, offset: 1 },
  { grep: "x", tail: 2 },
  { offset: -1 },
  { tail: 1.5 },
  { context: 3 },
  { grep: "[" },
  { grep: "x", context: 21 },
  { limit: 0 },
])("rejects invalid mode %j", (mode) => {
  expect(() => sliceLog(["x"], mode)).toThrow();
});
