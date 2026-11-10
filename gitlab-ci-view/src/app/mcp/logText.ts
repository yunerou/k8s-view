import { stripVTControlCharacters } from "node:util";

export interface LogMode {
  tail?: number;
  offset?: number;
  limit?: number;
  grep?: string;
  context?: number;
}

export function cleanLog(raw: string): string[] {
  const text = stripVTControlCharacters(raw)
    .replace(/section_(?:start|end):\d+:[^\r\n]*(?:\r)?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function validateLogMode(mode: LogMode): void {
  const range = mode.offset !== undefined || mode.limit !== undefined;
  const grep = mode.grep !== undefined || mode.context !== undefined;
  if (Number(mode.tail !== undefined) + Number(range) + Number(grep) > 1) {
    throw new Error("Choose one log mode: tail, offset + limit, or grep + context");
  }
  if (mode.context !== undefined && mode.grep === undefined) throw new Error("context requires grep");
  for (const key of ["tail", "offset", "limit", "context"] as const) {
    const value = mode[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "context" ? 0 : 1))) {
      throw new Error(`${key} must be a ${key === "context" ? "nonnegative" : "positive"} integer`);
    }
  }
  if ((mode.context ?? 0) > 20) throw new Error("context must be at most 20");
}

/** Caps output only. The caller downloads the entire trace; grep uses JavaScript regexes. */
export function sliceLog(lines: readonly string[], mode: LogMode = {}) {
  validateLogMode(mode);
  let indices: number[] = [];
  let truncated = false;
  if (mode.grep !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(mode.grep);
    } catch {
      throw new Error("Invalid grep pattern");
    }
    const selected = new Set<number>();
    let matches = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      if (++matches > 50) {
        truncated = true;
        break;
      }
      for (let j = Math.max(0, i - (mode.context ?? 3)); j <= Math.min(lines.length - 1, i + (mode.context ?? 3)); j++)
        selected.add(j);
    }
    indices = [...selected].sort((a, b) => a - b);
  } else {
    const start =
      mode.offset !== undefined || mode.limit !== undefined
        ? (mode.offset ?? 1) - 1
        : Math.max(0, lines.length - (mode.tail ?? 200));
    const end =
      mode.offset !== undefined || mode.limit !== undefined
        ? Math.min(lines.length, start + (mode.limit ?? 200))
        : lines.length;
    indices = Array.from({ length: Math.max(0, Math.min(end - start, 2001)) }, (_, i) => start + i);
    truncated = end < lines.length || end - start > 2000;
  }
  const output: string[] = [];
  let bytes = 0;
  let fromLine = 0;
  let toLine = 0;
  for (const i of indices) {
    if (output.length === 2000) {
      truncated = true;
      break;
    }
    const line = mode.grep !== undefined ? `${i + 1}: ${lines[i]}` : lines[i]!;
    const remaining = 200 * 1024 - bytes - (output.length ? 1 : 0);
    const size = Buffer.byteLength(line);
    if (size > remaining) {
      // A single oversized line is returned partially, preserving UTF-8 code points.
      let partial = "";
      let used = 0;
      for (const char of line) {
        const count = Buffer.byteLength(char);
        if (used + count > remaining) break;
        partial += char;
        used += count;
      }
      if (partial) {
        output.push(partial);
        fromLine ||= i + 1;
        toLine = i + 1;
      }
      truncated = true;
      break;
    }
    bytes += size + (output.length ? 1 : 0);
    output.push(line);
    fromLine ||= i + 1;
    toLine = i + 1;
  }
  return {
    totalLines: lines.length,
    fromLine,
    toLine,
    truncated,
    text: output.join("\n"),
    ...(truncated
      ? {
          hint: `Continue with offset=${Math.max(1, toLine + 1)} and limit=200; for a partially returned oversized line use a narrower grep or view the trace in VS Code.`,
        }
      : {}),
  };
}
