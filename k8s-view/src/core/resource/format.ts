const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/** Short kubectl-style age: 45s, 5m, 5h, 2d, 2y. */
export function formatAge(ms: number): string {
  if (ms < 0 || Number.isNaN(ms)) return "0s";
  if (ms < 2 * MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < 2 * HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 2 * YEAR) return `${Math.floor(ms / DAY)}d`;
  return `${Math.floor(ms / YEAR)}y`;
}

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Memory/storage quantities → readable binary units; CPU (`500m`) and unrecognized strings remain unchanged. */
export function formatQuantity(value: string): string {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]{0,2})$/.exec(value.trim());
  if (!m) return value;
  const n = Number(m[1]);
  const suffix = m[2] ?? "";
  const factor = suffix === "" ? 1 : (BINARY[suffix] ?? DECIMAL[suffix]);
  if (factor === undefined) return value;
  const bytes = n * factor;
  const units = ["Ei", "Pi", "Ti", "Gi", "Mi", "Ki"] as const;
  for (const u of units) {
    const size = BINARY[u]!;
    if (bytes >= size) return `${trim(bytes / size)}${u}`;
  }
  return trim(bytes);
}

function trim(n: number): string {
  return String(Math.round(n * 10) / 10);
}
