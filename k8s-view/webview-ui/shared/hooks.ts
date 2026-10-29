import { useEffect, useRef, useState } from "react";
import type { NotificationType } from "vscode-messenger-common";
import { onNotification } from "./messenger";

/** Listen for extension notifications, always using the latest handler. */
export function useNotification<P>(type: NotificationType<P>, handler: (params: P) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onNotification(type, (p) => ref.current(p)), [type]);
}

/** Periodically updated `Date.now()` (Age column). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Call `fn` after `delayMs` since the last call, per key. */
export function useDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): (key: string, ...args: A) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);
  const call = useRef((key: string, ...args: A) => {
    const map = timers.current;
    const old = map.get(key);
    if (old) clearTimeout(old);
    map.set(
      key,
      setTimeout(() => {
        map.delete(key);
        fnRef.current(...args);
      }, delayMs),
    );
  });
  return call.current;
}

/** Concise request error message. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
