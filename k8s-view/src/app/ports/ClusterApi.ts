/** API server error, retaining the HTTP status to distinguish 401/403/404/410. */
export class KubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "KubeApiError";
  }

  static isForbidden(e: unknown): boolean {
    return e instanceof KubeApiError && e.status === 403;
  }
}

/** Port: cluster calls required by ContextService. */
export abstract class ClusterApi {
  /** `/version`; throws on timeout/auth failure or when `signal` is aborted. */
  abstract version(context: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  /**
   * The context's user uses an exec auth plugin and has no valid credentials (or `reauthenticate`: always sign in
   * again, e.g. the Reconnect button for passkey/password entry): the plugin must run in a terminal.
   */
  abstract needsLogin(context: string, reauthenticate?: boolean): boolean;
  /** Run the exec auth plugin in an interactive terminal; resolve when credentials are available, throw on plugin failure or cancellation. */
  abstract login(context: string, signal: AbortSignal, reauthenticate?: boolean): Promise<void>;
  /** Namespace list; throws `KubeApiError` 403 without list permission. */
  abstract listNamespaces(context: string): Promise<string[]>;
}
