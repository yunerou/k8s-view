import * as l10n from "@vscode/l10n";
import type { ConnectionInfo, StatusLevel, WatchInfo } from "../../src/shared/protocol";
import { Codicon } from "./Codicon";
import { StatusDot } from "./StatusDot";
import { VscodeButton } from "./vsc";

/** Reconnect; contexts using exec auth sign in again in the terminal (passkey/password). */
function ReconnectButton({ onReconnect }: { readonly onReconnect: () => void }) {
  return (
    <button
      type="button"
      className="icon-button status-action"
      aria-label={l10n.t("Reconnect")}
      title={l10n.t("Reconnect (exec auth contexts sign in again in a terminal)")}
      onClick={onReconnect}
    >
      <Codicon name="refresh" />
    </button>
  );
}

export function ConnectionLine({
  connection,
  onReconnect,
  onCancel,
}: {
  readonly connection: ConnectionInfo;
  readonly onReconnect: () => void;
  readonly onCancel: () => void;
}) {
  switch (connection.state) {
    case "connecting":
      return (
        <div className="status-line" role="status">
          <Codicon name="loading" className="codicon-modifier-spin" />
          <span className="status-message">
            {connection.login ? l10n.t("Waiting for sign-in in the terminal…") : l10n.t("Connecting…")}
          </span>
          <VscodeButton secondary onClick={onCancel}>
            {l10n.t("Cancel")}
          </VscodeButton>
        </div>
      );
    case "connected":
      return (
        <div className="status-line" role="status">
          <StatusDot level="ok" label={l10n.t("Connected")} />
          <span>{l10n.t("Connected · {0}", connection.serverVersion)}</span>
          <ReconnectButton onReconnect={onReconnect} />
        </div>
      );
    case "error":
      return (
        <div className="status-line error" role="alert">
          <StatusDot level="error" label={l10n.t("Connection error")} />
          <span className="status-message">{connection.message}</span>
          <VscodeButton
            secondary
            title={l10n.t("Exec auth contexts sign in again in a terminal")}
            onClick={onReconnect}
          >
            {l10n.t("Retry")}
          </VscodeButton>
        </div>
      );
    default:
      return (
        <div className="status-line muted" role="status">
          <StatusDot level="unknown" label={l10n.t("Not connected")} />
          <span>{l10n.t("Not connected")}</span>
          <ReconnectButton onReconnect={onReconnect} />
        </div>
      );
  }
}

const WATCH_LEVEL: Record<WatchInfo["state"], StatusLevel> = {
  live: "ok",
  polling: "progress",
  paused: "unknown",
  idle: "unknown",
  error: "error",
};

function watchText(watch: WatchInfo, refreshMode: "watch" | "poll" | "manual"): string {
  switch (watch.state) {
    case "live":
      return l10n.t("Live · {0} watches", watch.watches);
    case "polling":
      return l10n.t("Polling · {0} watches", watch.watches);
    case "paused":
      return l10n.t("Paused");
    case "error":
      return l10n.t("Watch error · {0} of {1} failing", watch.errors, watch.watches);
    default:
      return refreshMode === "manual" ? l10n.t("Manual refresh") : l10n.t("Idle");
  }
}

export function WatchLine({
  watch,
  refreshMode,
}: {
  readonly watch: WatchInfo;
  readonly refreshMode: "watch" | "poll" | "manual";
}) {
  const text = watchText(watch, refreshMode);
  return (
    <div
      className={`status-line${watch.state === "error" ? " error" : ""}`}
      role="status"
      title={l10n.t("Refresh mode: {0}", refreshMode)}
    >
      <StatusDot level={WATCH_LEVEL[watch.state]} label={text} />
      <span>{text}</span>
      {watch.message && <span className="status-message muted"> — {watch.message}</span>}
    </div>
  );
}
