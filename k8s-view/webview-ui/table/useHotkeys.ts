import { useEffect, useRef } from "react";
import { eventChord, type HotkeyAction, type HotkeyState } from "../../src/shared/hotkeys";

/** While typing (filter field, select, etc.), keys enter text rather than trigger hotkeys. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return target.type !== "checkbox";
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

/**
 * Handle keys on `document` when hotkey mode is ON. Call `stopPropagation` for matching bindings: VS Code forwards
 * webview keydown events via a `window` listener (bubble), so these keys never reach VS Code keybindings.
 */
export function useHotkeys(state: HotkeyState | undefined, run: (action: HotkeyAction) => void): void {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!state?.enabled) return;
    const bindings = new Map(state.bindings.map((b) => [b.key, b.action]));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isEditable(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[role='menu'], [role='dialog']")) return;
      const action = bindings.get(eventChord(e));
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runRef.current(action);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state]);
}
