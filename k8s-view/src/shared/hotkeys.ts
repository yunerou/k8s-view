/** Table hotkeys: shared by the extension (reads config) and webview (handles keys). */

export const HOTKEY_ACTIONS = [
  "prevSection",
  "nextSection",
  "focusFilter",
  "toggleFilters",
  "nextError",
  "prevError",
  "details",
  "manifest",
  "commands",
  "runLast",
  "refresh",
  "pickNamespace",
  "pickView",
  "help",
  "none",
] as const;
export type HotkeyActionName = (typeof HOTKEY_ACTIONS)[number];

export type HotkeyAction =
  | { readonly action: HotkeyActionName }
  /** Id view. */
  | { readonly view: string }
  /** Slot (1–9) trong setting `k8sView.views.favorites`. */
  | { readonly favorite: number }
  | { readonly namespace: string }
  | { readonly allNamespaces: true }
  /** Config command ID, executed on selected rows. */
  | { readonly command: string };

export interface HotkeySpec {
  /** As entered by the user: `shift+1`, `cmd+r`, `?`. */
  readonly key: string;
  readonly action: HotkeyAction;
}

export interface HotkeyBinding {
  /** Normalized chord (`shift+Digit1`), compared with `eventChord`. */
  readonly key: string;
  readonly label: string;
  readonly action: HotkeyAction;
}

export interface HotkeyState {
  readonly enabled: boolean;
  readonly bindings: readonly HotkeyBinding[];
  /** Favorite view titles by slot (element `i` = key `i + 1`); empty string = empty slot. */
  readonly favorites: readonly string[];
}

const digits = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const DEFAULT_HOTKEYS: readonly HotkeySpec[] = [
  ...digits(1, 9).map((n) => ({ key: String(n), action: { favorite: n } })),
  { key: "shift+0", action: { allNamespaces: true } },
  { key: "[", action: { action: "prevSection" } },
  { key: "]", action: { action: "nextSection" } },
  { key: "e", action: { action: "nextError" } },
  { key: "shift+e", action: { action: "prevError" } },
  { key: "c", action: { action: "commands" } },
  { key: ".", action: { action: "runLast" } },
  { key: "d", action: { action: "details" } },
  { key: "y", action: { action: "manifest" } },
  { key: "/", action: { action: "focusFilter" } },
  { key: "f", action: { action: "toggleFilters" } },
  { key: "r", action: { action: "refresh" } },
  { key: "n", action: { action: "pickNamespace" } },
  { key: "v", action: { action: "pickView" } },
  { key: "?", action: { action: "help" } },
];

const MODIFIERS: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  super: "meta",
};
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

const PUNCTUATION: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  ".": "Period",
  ",": "Comma",
  ";": "Semicolon",
  "'": "Quote",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  "\\": "Backslash",
};

const NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function keyCode(key: string): { code: string; shift?: boolean } | undefined {
  if (/^[a-z]$/.test(key)) return { code: `Key${key.toUpperCase()}` };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}` };
  if (key === "?") return { code: "Slash", shift: true };
  if (/^f([1-9]|1[0-2])$/.test(key)) return { code: key.toUpperCase() };
  const code = PUNCTUATION[key] ?? NAMED[key];
  return code ? { code } : undefined;
}

function chord(mods: ReadonlySet<string>, code: string): string {
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), code].join("+");
}

/** `shift+1` → `shift+Digit1`; undefined for unrecognized keys. Based on `KeyboardEvent.code`, so independent of keyboard layout. */
export function parseChord(spec: string): string | undefined {
  const parts = spec.trim().toLowerCase().split("+");
  const last = parts.pop();
  if (!last) return undefined;
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MODIFIERS[p];
    if (!m) return undefined;
    mods.add(m);
  }
  const k = keyCode(last);
  if (!k) return undefined;
  if (k.shift) mods.add("shift");
  return chord(mods, k.code);
}

export function eventChord(e: {
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}): string {
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add("ctrl");
  if (e.altKey) mods.add("alt");
  if (e.shiftKey) mods.add("shift");
  if (e.metaKey) mods.add("meta");
  return chord(mods, e.code);
}

/** Defaults + config bindings (later bindings win for the same chord); `{ action: "none" }` removes a binding. */
export function resolveHotkeys(specs: readonly HotkeySpec[]): HotkeyBinding[] {
  const out = new Map<string, HotkeyBinding>();
  for (const spec of [...DEFAULT_HOTKEYS, ...specs]) {
    const key = parseChord(spec.key);
    if (!key) continue;
    if ("action" in spec.action && spec.action.action === "none") out.delete(key);
    else out.set(key, { key, label: spec.key, action: spec.action });
  }
  return [...out.values()];
}
