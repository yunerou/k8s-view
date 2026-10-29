import * as l10n from "@vscode/l10n";
import type { StatusLevel } from "../../src/shared/protocol";

export function levelLabel(level: StatusLevel): string {
  switch (level) {
    case "ok":
      return l10n.t("OK");
    case "warning":
      return l10n.t("Warning");
    case "error":
      return l10n.t("Error");
    case "progress":
      return l10n.t("In progress");
    default:
      return l10n.t("Unknown");
  }
}

/** Status dot; colors come from theme variables (see base.css). */
export function StatusDot({ level, label }: { readonly level: StatusLevel; readonly label?: string }) {
  return <span className={`status-dot level-${level}`} role="img" aria-label={label ?? levelLabel(level)} />;
}
