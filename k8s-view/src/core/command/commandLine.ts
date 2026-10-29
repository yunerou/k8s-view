/**
 * Split user-entered commands ("Create snippet" wizard) into argv using near-POSIX shell rules:
 * whitespace separates arguments, single quotes preserve text, double quotes allow `\"` and `\\`, and unquoted `\` escapes one character.
 * `${…}` templates remain within a single argument, even when they contain whitespace.
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "$" && line[i + 1] === "{") {
      const end = line.indexOf("}", i);
      if (end > i) {
        current += line.slice(i, end + 1);
        started = true;
        i = end;
        continue;
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new SyntaxError(`Unterminated ${quote === "'" ? "single" : "double"} quote`);
  if (started) args.push(current);
  return args;
}

/** Command lines using shell syntax (pipes, redirects, command chaining, etc.) must run via `sh -c`. */
export function needsShell(line: string): boolean {
  const outsideTemplates = line.replace(/\$\{[^}]*\}/g, "");
  return /[|<>;&`]|\$\(/.test(outsideTemplates);
}

/** Unique `${input:<id>}` parameter IDs in order of appearance. */
export function inputIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/\$\{input:([A-Za-z0-9][A-Za-z0-9._-]*)(?:\|[^}]*)?\}/g)) {
    if (!ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}
