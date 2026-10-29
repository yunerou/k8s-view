export interface LogRequest {
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  readonly follow: boolean;
  /** Number of tail lines on startup; omitted = all (or since `sinceTime`). */
  readonly tailLines?: number;
  /** RFC3339: fetch only logs after this time (resume after a stream disconnects). */
  readonly sinceTime?: string;
  readonly timestamps: boolean;
}

/** Port: stream a container's logs via the API server (`pods/<name>/log`); infra binds `KubeLogSource`. */
export abstract class LogSource {
  /**
   * Call `onData` for each text chunk; resolve when the server closes the stream (container stops, logs end without follow,
   * or `signal` is aborted); reject on error (`KubeApiError` with HTTP status).
   */
  abstract stream(
    context: string,
    request: LogRequest,
    onData: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
