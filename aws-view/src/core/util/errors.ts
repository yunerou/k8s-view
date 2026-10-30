export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The user canceled (input dismissed, progress Cancel): callers stay silent. */
export class CanceledError extends Error {
  constructor() {
    super("Canceled");
    this.name = "AbortError";
  }
}

/** `CanceledError` and the `DOMException` thrown by `AbortSignal.throwIfAborted()`. */
export function isCanceled(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}
