/** GitLab job log parser: ANSI colors (SGR), `\r` line overwrites, and `section_start/section_end` markers. Used in the webview. */

export interface Span {
  readonly text: string;
  /** `ansi-0`…`ansi-15` (terminal theme colors) or `#rrggbb`. */
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

export interface LineEntry {
  readonly kind: "line";
  readonly spans: readonly Span[];
  /** IDs of sections containing this line, outermost first. */
  readonly sections: readonly string[];
}

export interface SectionEntry {
  readonly kind: "section";
  /** `<name>#<index>`: section names may repeat. */
  readonly id: string;
  readonly name: string;
  readonly spans: readonly Span[];
  readonly sections: readonly string[];
  readonly collapsed: boolean;
  /** Seconds; available once `section_end` is encountered. */
  readonly duration?: number;
}

export type TraceEntry = LineEntry | SectionEntry;

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type MutableSection = { -readonly [K in keyof SectionEntry]: SectionEntry[K] };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes
const ANSI = /\x1b\[([0-9;]*)([A-Za-z])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: GitLab markers end with \r ESC[0K
const SECTION = /section_(start|end):(\d+):([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?\r?(?:\x1b\[0K)?/g;

export class TraceParser {
  private buffer = "";
  private readonly out: (LineEntry | MutableSection)[] = [];
  private readonly open: { name: string; start: number; entry: MutableSection }[] = [];
  private style: Style = {};
  private counter = 0;

  push(chunk: string): void {
    const parts = (this.buffer + chunk).split("\n");
    this.buffer = parts.pop() ?? "";
    for (const line of parts) this.line(line);
  }

  /** Completed lines + the current partial line (without `\n` yet). */
  snapshot(): TraceEntry[] {
    const entries: TraceEntry[] = this.out.map((e) => (e.kind === "section" ? { ...e } : e));
    if (this.buffer) {
      const text = lastRewrite(this.buffer.replace(SECTION, ""));
      entries.push({ kind: "line", spans: parseSpans(text, this.style).spans, sections: this.path() });
    }
    return entries;
  }

  private path(): string[] {
    return this.open.map((o) => o.entry.id);
  }

  private spans(text: string): Span[] {
    const r = parseSpans(lastRewrite(text), this.style);
    this.style = r.style;
    return r.spans;
  }

  private line(raw: string): void {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const markers = [...text.matchAll(SECTION)];
    if (markers.length === 0) {
      this.out.push({ kind: "line", spans: this.spans(text), sections: this.path() });
      return;
    }
    let header: MutableSection | undefined;
    const flush = (segment: string) => {
      if (header) {
        header.spans = this.spans(segment);
        header = undefined;
      } else if (segment) {
        this.out.push({ kind: "line", spans: this.spans(segment), sections: this.path() });
      }
    };
    let last = 0;
    for (const m of markers) {
      const index = m.index ?? 0;
      flush(text.slice(last, index));
      last = index + m[0].length;
      const name = m[3] ?? "";
      const time = Number(m[2]);
      if (m[1] === "start") {
        const entry: MutableSection = {
          kind: "section",
          id: `${name}#${++this.counter}`,
          name,
          spans: [],
          sections: this.path(),
          collapsed: /(^|,)\s*collapsed=true\s*(,|$)/.test(m[4] ?? ""),
        };
        this.out.push(entry);
        this.open.push({ name, start: time, entry });
        header = entry;
      } else {
        const i = this.open.map((o) => o.name).lastIndexOf(name);
        const opened = this.open[i];
        if (opened) {
          opened.entry.duration = Math.max(0, time - opened.start);
          this.open.length = i;
        }
      }
    }
    flush(text.slice(last));
  }
}

/** Render `a\rb\rc` like a terminal: the last nonempty write wins. */
function lastRewrite(text: string): string {
  const parts = text.split("\r");
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i]!;
  return "";
}

export function parseSpans(text: string, start: Style): { spans: Span[]; style: Style } {
  const spans: Span[] = [];
  let style = start;
  let last = 0;
  for (const m of text.matchAll(ANSI)) {
    const index = m.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index), ...style });
    last = index + m[0].length;
    if (m[2] === "m") style = applySgr(style, m[1] ?? "");
  }
  if (last < text.length) spans.push({ text: text.slice(last), ...style });
  return { spans, style };
}

function applySgr(style: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p) || 0);
  let s: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) delete s.bold;
    else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c >= 30 && c <= 37) s.fg = `ansi-${c - 30}`;
    else if (c >= 90 && c <= 97) s.fg = `ansi-${c - 82}`;
    else if (c === 39) delete s.fg;
    else if (c >= 40 && c <= 47) s.bg = `ansi-${c - 40}`;
    else if (c >= 100 && c <= 107) s.bg = `ansi-${c - 92}`;
    else if (c === 49) delete s.bg;
    else if (c === 38 || c === 48) {
      const color = extendedColor(codes, i);
      if (!color) continue;
      if (c === 38) s.fg = color.value;
      else s.bg = color.value;
      i += color.consumed;
    }
  }
  return s;
}

function extendedColor(codes: readonly number[], i: number): { value: string; consumed: number } | undefined {
  const n = codes[i + 2];
  if (codes[i + 1] === 5 && n !== undefined) return { value: n < 16 ? `ansi-${n}` : xterm256(n), consumed: 2 };
  const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
  if (codes[i + 1] === 2 && r !== undefined && g !== undefined && b !== undefined) {
    return { value: hex(r, g, b), consumed: 4 };
  }
  return undefined;
}

function xterm256(n: number): string {
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return hex(v, v, v);
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return hex(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
}

function hex(...rgb: number[]): string {
  return `#${rgb.map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** Exclude lines in collapsed sections. `toggled` = sections whose default state the user has toggled. */
export function visibleEntries(entries: readonly TraceEntry[], toggled: ReadonlySet<string>): TraceEntry[] {
  const collapsed = new Set<string>();
  const out: TraceEntry[] = [];
  for (const e of entries) {
    if (!e.sections.some((id) => collapsed.has(id))) out.push(e);
    if (e.kind === "section" && e.collapsed !== toggled.has(e.id)) collapsed.add(e.id);
  }
  return out;
}

export function entryText(e: TraceEntry): string {
  const text = e.spans.map((s) => s.text).join("");
  return e.kind === "section" && !text ? e.name : text;
}

export function findMatches(entries: readonly TraceEntry[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  return entries.flatMap((e, i) => (entryText(e).toLowerCase().includes(q) ? [i] : []));
}
