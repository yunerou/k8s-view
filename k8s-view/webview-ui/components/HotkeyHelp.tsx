import * as l10n from "@vscode/l10n";
import { useEffect, useRef } from "react";
import type { HotkeyAction, HotkeyActionName, HotkeyBinding } from "../../src/shared/hotkeys";
import { Codicon } from "./Codicon";

function actionLabel(name: HotkeyActionName): string {
  switch (name) {
    case "prevSection":
      return l10n.t("Previous section");
    case "nextSection":
      return l10n.t("Next section");
    case "focusFilter":
      return l10n.t("Focus the filter box");
    case "toggleFilters":
      return l10n.t("Show/hide column filters");
    case "nextError":
      return l10n.t("Next row in error");
    case "prevError":
      return l10n.t("Previous row in error");
    case "details":
      return l10n.t("Details");
    case "manifest":
      return l10n.t("Open manifest");
    case "commands":
      return l10n.t("Commands for the selected rows");
    case "runLast":
      return l10n.t("Run last command on the selected rows");
    case "refresh":
      return l10n.t("Refresh");
    case "pickNamespace":
      return l10n.t("Select namespace…");
    case "pickView":
      return l10n.t("Switch view…");
    case "help":
      return l10n.t("Show this list");
    case "none":
      return "";
  }
}

export function describeHotkey(action: HotkeyAction, favorites: readonly string[]): string {
  if ("action" in action) return actionLabel(action.action);
  if ("view" in action) return l10n.t("View {0}", action.view);
  if ("favorite" in action) {
    const title = favorites[action.favorite - 1];
    return title
      ? l10n.t("Favorite view {0}: {1}", action.favorite, title)
      : l10n.t("Favorite view {0} (empty)", action.favorite);
  }
  if ("namespace" in action) return l10n.t("Namespace {0}", action.namespace);
  if ("allNamespaces" in action) return l10n.t("All namespaces");
  return l10n.t("Run command {0}", action.command);
}

/** Hotkey list (`?` key or "Hotkeys ON" badge); Esc closes it. */
export function HotkeyHelp({
  bindings,
  favorites,
  onClose,
}: {
  readonly bindings: readonly HotkeyBinding[];
  readonly favorites: readonly string[];
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={l10n.t("Table hotkeys")}
      className="hotkey-help"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="hotkey-help-head">
        <h2>{l10n.t("Table hotkeys")}</h2>
        <button type="button" className="icon-button" aria-label={l10n.t("Close")} onClick={onClose}>
          <Codicon name="close" />
        </button>
      </div>
      <p className="muted">
        {l10n.t(
          "Active while hotkey mode is ON; set them in the 'hotkeys' section of a config file. Favorite views: command 'K8s View: Configure favorite views…'.",
        )}
      </p>
      <table>
        <tbody>
          {bindings.map((b) => (
            <tr key={b.key}>
              <td>
                <kbd>{b.label}</kbd>
              </td>
              <td>{describeHotkey(b.action, favorites)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
