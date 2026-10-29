import { describe, expect, test } from "vitest";
import { entryText, findMatches, TraceParser, visibleEntries } from "../../../src/shared/trace";

const ESC = "\u001b";
const texts = (p: TraceParser) => p.snapshot().map(entryText);

describe("TraceParser", () => {
  test("splits lines across chunks and shows the unfinished line", () => {
    const p = new TraceParser();
    p.push("a\nb");
    expect(texts(p)).toEqual(["a", "b"]);
    p.push("c\n\n");
    expect(texts(p)).toEqual(["a", "bc", ""]);
  });

  test("SGR colours, bold and reset", () => {
    const p = new TraceParser();
    p.push(`${ESC}[31;1mred${ESC}[0m plain\n`);
    expect(p.snapshot()[0]?.spans).toEqual([{ text: "red", fg: "ansi-1", bold: true }, { text: " plain" }]);
  });

  test("style carries over to the next line until reset (GitLab uses ESC[0;m)", () => {
    const p = new TraceParser();
    p.push(`${ESC}[32mgreen\nstill${ESC}[0;m done\n`);
    expect(p.snapshot()[1]?.spans).toEqual([{ text: "still", fg: "ansi-2" }, { text: " done" }]);
  });

  test("256 colours and true colour", () => {
    const p = new TraceParser();
    p.push(`${ESC}[38;5;208mo${ESC}[48;2;255;0;16mx${ESC}[39;49m.${ESC}[94mB\n`);
    expect(p.snapshot()[0]?.spans).toEqual([
      { text: "o", fg: "#ff8700" },
      { text: "x", fg: "#ff8700", bg: "#ff0010" },
      { text: "." },
      { text: "B", fg: "ansi-12" },
    ]);
  });

  test("carriage returns keep the last rewrite of the line", () => {
    const p = new TraceParser();
    p.push("10%\r50%\r100%\r\n");
    expect(texts(p)).toEqual(["100%"]);
  });

  test("GitLab sections become collapsible headers with durations", () => {
    const p = new TraceParser();
    p.push(`section_start:1700000000:prepare[collapsed=true]\r${ESC}[0K${ESC}[36;1mPreparing${ESC}[0;m\n`);
    p.push("inside\n");
    p.push(`section_end:1700000005:prepare\r${ESC}[0Ksection_start:1700000005:script\r${ESC}[0KRunning script\n`);
    p.push("$ make\n");
    p.push(`section_end:1700000012:script\r${ESC}[0K\n`);
    p.push("after\n");
    const entries = p.snapshot();
    expect(entries.map((e) => [e.kind, entryText(e), e.sections])).toEqual([
      ["section", "Preparing", []],
      ["line", "inside", ["prepare#1"]],
      ["section", "Running script", []],
      ["line", "$ make", ["script#2"]],
      ["line", "after", []],
    ]);
    expect(entries[0]).toMatchObject({ id: "prepare#1", collapsed: true, duration: 5 });
    expect(entries[0]?.spans).toEqual([{ text: "Preparing", fg: "ansi-6", bold: true }]);
    expect(entries[2]).toMatchObject({ id: "script#2", collapsed: false, duration: 7 });
  });

  test("an unfinished marker line is not shown raw", () => {
    const p = new TraceParser();
    p.push(`section_start:1:step\r${ESC}[0K`);
    expect(texts(p)).toEqual([""]);
  });

  test("a repeated section name gets a new id", () => {
    const p = new TraceParser();
    p.push("section_start:1:step\rA\nsection_end:2:step\rsection_start:3:step\rB\n");
    expect(p.snapshot().map((e) => (e.kind === "section" ? e.id : ""))).toEqual(["step#1", "step#2"]);
  });
});

describe("visibleEntries / findMatches", () => {
  const p = new TraceParser();
  p.push("section_start:1:prepare[collapsed=true]\rPrep\nhidden\nsection_end:2:prepare\r\n");
  p.push("section_start:2:script\rScript\n$ make\nsection_end:3:script\r\n");
  const entries = p.snapshot();

  test("collapsed sections hide their lines; toggling flips the default", () => {
    expect(visibleEntries(entries, new Set()).map(entryText)).toEqual(["Prep", "Script", "$ make"]);
    expect(visibleEntries(entries, new Set(["prepare#1", "script#2"])).map(entryText)).toEqual([
      "Prep",
      "hidden",
      "Script",
    ]);
  });

  test("search is case-insensitive and returns indexes", () => {
    expect(findMatches(entries, "MAKE")).toEqual([3]);
    expect(findMatches(entries, "")).toEqual([]);
  });
});
