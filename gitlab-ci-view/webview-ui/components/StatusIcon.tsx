import { statusIcon, statusLabel, statusLevel } from "../../src/core/gitlab/status";

/** Pipeline/job status icon; `sync~spin` → codicon's spinning class. */
export function StatusIcon({
  status,
  allowFailure = false,
}: {
  readonly status: string;
  readonly allowFailure?: boolean;
}) {
  const [name, modifier] = statusIcon(status, allowFailure).split("~");
  const label = allowFailure && status === "failed" ? "failed (allowed)" : statusLabel(status);
  return (
    <span
      className={`codicon codicon-${name}${modifier === "spin" ? " codicon-modifier-spin" : ""} level-${statusLevel(status, allowFailure)}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
