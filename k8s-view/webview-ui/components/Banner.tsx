import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Codicon } from "./Codicon";

export function Banner({
  kind,
  children,
  onDismiss,
}: {
  readonly kind: "warning" | "error" | "info";
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
}) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "info" ? "status" : "alert"}>
      <Codicon name={kind} />
      <div className="banner-body">{children}</div>
      {onDismiss && (
        <button type="button" className="icon-button" onClick={onDismiss} aria-label={l10n.t("Dismiss")}>
          <Codicon name="close" />
        </button>
      )}
    </div>
  );
}
