/**
 * Terminal log formatting (ANSI): pod/container prefixes with a distinct color per source, colored log level keywords (ERROR, WARN…),
 * and dimmed timestamps. Independent of VS Code.
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
/** Prefix colors: avoid red (reserved for errors) so source names are not confused with log levels. */
const PALETTE = [36, 32, 35, 33, 34, 96, 92, 95, 93, 94];

const LEVELS: readonly { readonly pattern: RegExp; readonly color: string }[] = [
  { pattern: /\b(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|EXCEPTION)\b/i, color: "\x1b[1;31m" },
  { pattern: /\b(WARN|WARNING)\b/i, color: "\x1b[1;33m" },
  { pattern: /\b(INFO)\b/, color: "\x1b[32m" },
  { pattern: /\b(DEBUG|TRACE)\b/, color: "\x1b[2;37m" },
];
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})) /;
// biome-ignore lint/suspicious/noControlCharactersInRegex: match ANSI escape codes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Stable source color (the same name always has the same color across sessions). */
export function colorFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export interface LogLineOptions {
  /** Source prefix (`pod/container`); omitted when there is only one source. */
  readonly prefix?: string;
  readonly color?: number;
  /** Color log level keywords and dim timestamps. */
  readonly highlight?: boolean;
}

/** One formatted log line (without a trailing newline). */
export function formatLogLine(line: string, options: LogLineOptions = {}): string {
  const text = options.highlight === false ? line : highlightLine(line);
  if (!options.prefix) return text;
  const color = options.color ?? colorFor(options.prefix);
  return `\x1b[${color}m${options.prefix}${RESET} ${text}`;
}

/** K8s View notification line (stream start/end, etc.), dimmed to distinguish it from actual logs. */
export function formatNotice(text: string, marker = "•"): string {
  return `${DIM}${marker} ${text}${RESET}`;
}

/**
 * Log level coloring: only the first keyword within the first ~120 characters (usually the level column), to avoid coloring
 * occurrences of "error" deep inside messages. Existing ANSI log colors are preserved.
 */
export function highlightLine(line: string): string {
  if (line.includes("\x1b[")) return line;
  let rest = line;
  let head = "";
  const ts = TIMESTAMP.exec(rest);
  if (ts) {
    head = `${DIM}${ts[1]}${RESET} `;
    rest = rest.slice(ts[0].length);
  }
  const window = rest.slice(0, 120);
  for (const level of LEVELS) {
    const m = level.pattern.exec(window);
    if (!m) continue;
    const at = m.index;
    return `${head}${rest.slice(0, at)}${level.color}${m[0]}${RESET}${rest.slice(at + m[0].length)}`;
  }
  return head + rest;
}

/** Strip ANSI codes (for tests and display width measurement). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Assemble stream chunks into complete lines; retain partial lines until the next chunk or `flush`. */
export class LineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    const text = this.pending + chunk;
    const lines = text.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines;
  }

  flush(): string[] {
    const rest = this.pending;
    this.pending = "";
    return rest ? [rest] : [];
  }
}
