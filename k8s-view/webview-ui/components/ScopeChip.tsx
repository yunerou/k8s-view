import * as l10n from "@vscode/l10n";
import type { TableScope } from "../../src/shared/protocol";
import { Codicon } from "./Codicon";

/** Header chip of an Open Related / Open Parent tab: source link and scope on/off. */
export function ScopeChip({
  scope,
  onToggle,
  onOpenSource,
}: {
  readonly scope: TableScope;
  readonly onToggle: (enabled: boolean) => void;
  readonly onOpenSource: () => void;
}) {
  const s = scope.source;
  const label = `${s.kind} ${s.namespace ? `${s.namespace}/` : ""}${s.name}`;
  return (
    <span className={scope.enabled ? "scope-chip" : "scope-chip off"}>
      <Codicon name={scope.direction === "related" ? "references" : "arrow-up"} />
      {scope.enabled ? (
        <>
          <span>{l10n.t("Scope:")}</span>
          <button type="button" className="link-button" title={l10n.t("Open manifest")} onClick={onOpenSource}>
            {label}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={l10n.t("Turn off scope")}
            title={l10n.t("Show all resources of these kinds")}
            onClick={() => onToggle(false)}
          >
            <Codicon name="close" />
          </button>
        </>
      ) : (
        <>
          <span>{l10n.t("Scope off")}</span>
          <button type="button" className="link-button" onClick={() => onToggle(true)}>
            {l10n.t("Restore")}
          </button>
        </>
      )}
    </span>
  );
}
