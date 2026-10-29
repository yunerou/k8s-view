import { act } from "@testing-library/react";
import { vi } from "vitest";

type Handler = (params: unknown) => void;

/** Replace `webview-ui/shared/messenger`: requests go through `respond(method, params)`, notifications are emitted via `notify`. */
export const handlers = new Map<string, Set<Handler>>();
export const respond = vi.fn<(method: string, params: unknown) => unknown>();
export let webviewState: unknown;

export const messengerModule = {
  request: vi.fn(async (type: { method: string }, params?: unknown) => respond(type.method, params)),
  onNotification: vi.fn((type: { method: string }, handler: Handler) => {
    const set = handlers.get(type.method) ?? new Set();
    set.add(handler);
    handlers.set(type.method, set);
    return () => set.delete(handler);
  }),
  getWebviewState: vi.fn(() => webviewState),
  setWebviewState: vi.fn((s: unknown) => {
    webviewState = s;
  }),
};

export function setInitialState(s: unknown): void {
  webviewState = s;
}

export function notify(method: string, params: unknown): void {
  act(() => {
    for (const h of handlers.get(method) ?? []) h(params);
  });
}

/** Request calls by method. */
export function requests(method: string): unknown[] {
  return messengerModule.request.mock.calls.filter(([t]) => t.method === method).map(([, p]) => p);
}

export function resetMessenger(): void {
  handlers.clear();
  respond.mockReset();
  messengerModule.request.mockClear();
  messengerModule.setWebviewState.mockClear();
  webviewState = undefined;
}
