import { HOST_EXTENSION, type NotificationType, type RequestType } from "vscode-messenger-common";
import { Messenger, type VsCodeApi } from "vscode-messenger-webview";

// `acquireVsCodeApi` may only be called once per webview.
let api: VsCodeApi | undefined;
let messenger: Messenger | undefined;

function vscodeApi(): VsCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}

function instance(): Messenger {
  if (!messenger) {
    messenger = new Messenger(vscodeApi());
    messenger.start();
  }
  return messenger;
}

export function request<P, R>(type: RequestType<P, R>, ...params: P extends void ? [] : [P]): Promise<R> {
  return instance().sendRequest(type, HOST_EXTENSION, params[0]);
}

/** Subscribe to notifications; return an unsubscribe function. */
export function onNotification<P>(type: NotificationType<P>, handler: (params: P) => void): () => void {
  const d = instance().onNotification(type, handler);
  return () => d.dispose();
}

export function getWebviewState<T>(): T | undefined {
  return vscodeApi().getState() as T | undefined;
}

export function setWebviewState<T>(state: T): void {
  vscodeApi().setState(state);
}
