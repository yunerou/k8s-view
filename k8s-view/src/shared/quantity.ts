/** Kubernetes quantities in cores (CPU) or bytes (memory); never parse a missing value as zero. */
export function parseQuantity(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const m = String(value).match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/);
  if (!m) return undefined;
  const suffix = m[2] ?? "";
  const decimal: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
  };
  const factor = /^[eE][+-]?\d+$/.test(suffix)
    ? 10 ** Number(suffix.slice(1))
    : suffix.endsWith("i")
      ? 1024 ** ("KMGTPE".indexOf(suffix[0]!) + 1)
      : (decimal[suffix] ?? 1);
  const n = Number(m[1]) * factor;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
