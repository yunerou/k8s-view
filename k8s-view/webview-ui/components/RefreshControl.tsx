import * as l10n from "@vscode/l10n";
import type { RefreshChoice } from "../../src/shared/protocol";
import { Codicon } from "./Codicon";

/** Quick poll intervals in the panel; custom values from settings are also displayed. */
export const POLL_INTERVALS = [3, 5, 10] as const;

interface Option {
  readonly value: RefreshChoice | "manual";
  readonly label: string;
  readonly title: string;
  readonly icon?: string;
}

/**
 * A radio button row (Pause | Live | 3s | 5s | 10s) replaces a toggle + dropdown: saves vertical space and avoids clipping
 * in narrow sidebars. Native radios support ←/→ selection.
 */
export function RefreshControl({
  autoRefresh,
  refreshMode,
  pollIntervalSeconds,
  onSelect,
}: {
  readonly autoRefresh: boolean;
  readonly refreshMode: "watch" | "poll" | "manual";
  readonly pollIntervalSeconds: number;
  readonly onSelect: (value: RefreshChoice) => void;
}) {
  const current: Option["value"] = !autoRefresh
    ? "pause"
    : refreshMode === "poll"
      ? pollIntervalSeconds
      : refreshMode === "manual"
        ? "manual"
        : "watch";
  const intervals: number[] = [...POLL_INTERVALS];
  if (refreshMode === "poll" && !intervals.includes(pollIntervalSeconds)) {
    intervals.push(pollIntervalSeconds);
    intervals.sort((a, b) => a - b);
  }
  const options: Option[] = [
    { value: "pause", label: l10n.t("Pause"), title: l10n.t("Pause: stop all updates"), icon: "debug-pause" },
    { value: "watch", label: l10n.t("Live"), title: l10n.t("Live: watch the cluster, changes appear immediately") },
    ...intervals.map((s) => ({
      value: s,
      label: l10n.t("{0}s", s),
      title: l10n.t("Poll the cluster every {0} seconds", s),
    })),
    ...(refreshMode === "manual"
      ? [
          {
            value: "manual" as const,
            label: l10n.t("Manual"),
            title: l10n.t("Manual (k8sView.refresh.mode): use Refresh"),
          },
        ]
      : []),
  ];

  const select = (value: Option["value"]) => {
    if (value !== current && value !== "manual") onSelect(value);
  };

  return (
    <div className="refresh-row">
      <span className="field-label" id="refresh-label">
        {l10n.t("Auto refresh")}
      </span>
      <fieldset className="segmented" aria-labelledby="refresh-label">
        {options.map((o) => {
          const checked = o.value === current;
          return (
            <label key={String(o.value)} className={`segment${checked ? " checked" : ""}`} title={o.title}>
              <input
                type="radio"
                name="k8s-view-refresh"
                value={String(o.value)}
                aria-label={o.label}
                checked={checked}
                onChange={() => select(o.value)}
              />
              {o.icon ? <Codicon name={o.icon} /> : o.label}
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}
