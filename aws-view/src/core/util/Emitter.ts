export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

/** Small emitter for `core`/`app` (no vscode import); `ui`/`infra` may use `vscode.EventEmitter`. */
export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
