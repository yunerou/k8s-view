import * as l10n from "@vscode/l10n";
import { useState } from "react";
import type { NamespaceScope } from "../../src/shared/protocol";
import { eventValue } from "../shared/events";
import { Codicon } from "./Codicon";
import { VscodeButton, VscodeOption, VscodeSingleSelect, VscodeTextfield } from "./vsc";

/** "All namespaces" option value (namespace names cannot contain `*`). */
export const ALL_NAMESPACES = "*";
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function NamespacePicker({
  scope,
  namespaces,
  forbidden,
  disabled,
  onSelect,
  onRefresh,
}: {
  readonly scope: NamespaceScope | undefined;
  readonly namespaces: readonly string[];
  readonly forbidden: boolean;
  readonly disabled: boolean;
  readonly onSelect: (scope: NamespaceScope) => void;
  readonly onRefresh: () => void;
}) {
  const [manual, setManual] = useState("");
  const value = scope?.type === "single" ? scope.name : ALL_NAMESPACES;
  const options =
    scope?.type === "single" && !namespaces.includes(scope.name) ? [scope.name, ...namespaces] : namespaces;
  const name = manual.trim();
  const valid = DNS_LABEL.test(name);
  const apply = () => valid && onSelect({ type: "single", name });

  return (
    <div className="field">
      <label className="field-label" htmlFor="namespace-select">
        {l10n.t("Namespace")}
      </label>
      <div className="field-row">
        <VscodeSingleSelect
          id="namespace-select"
          aria-label={l10n.t("Namespace")}
          combobox
          filter="contains"
          disabled={disabled}
          value={value}
          onChange={(e) => {
            const v = eventValue(e);
            if (v && v !== value) onSelect(v === ALL_NAMESPACES ? { type: "all" } : { type: "single", name: v });
          }}
        >
          <VscodeOption value={ALL_NAMESPACES}>{l10n.t("All namespaces")}</VscodeOption>
          {options.map((ns) => (
            <VscodeOption key={ns} value={ns}>
              {ns}
            </VscodeOption>
          ))}
        </VscodeSingleSelect>
        <button
          type="button"
          className="icon-button"
          disabled={disabled}
          aria-label={l10n.t("Refresh namespaces")}
          title={l10n.t("Refresh namespaces")}
          onClick={onRefresh}
        >
          <Codicon name="refresh" />
        </button>
      </div>
      {forbidden && (
        <div className="manual-namespace">
          <p className="hint">
            <Codicon name="info" />{" "}
            {l10n.t("You cannot list namespaces in this cluster. Type a namespace name instead.")}
          </p>
          <div className="field-row">
            <VscodeTextfield
              aria-label={l10n.t("Namespace name")}
              placeholder={l10n.t("namespace")}
              value={manual}
              invalid={name !== "" && !valid}
              disabled={disabled}
              onInput={(e) => setManual(eventValue(e))}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
              }}
            />
            <VscodeButton disabled={disabled || !valid} onClick={apply}>
              {l10n.t("Apply")}
            </VscodeButton>
          </div>
        </div>
      )}
    </div>
  );
}
