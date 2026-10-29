import * as l10n from "@vscode/l10n";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { SectionPrefs, TableSection } from "../../src/shared/protocol";
import { initialColumnOrder, initialVisibility, withPref } from "../table/model";
import { Codicon } from "./Codicon";

/** The "Columns" button opens a column visibility list (menuitemcheckbox). */
export function ColumnMenu({
  section,
  prefs,
  onPrefsChange,
}: {
  readonly section: TableSection;
  readonly prefs: SectionPrefs;
  readonly onPrefsChange: (prefs: SectionPrefs) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const visible = initialVisibility(section, prefs);
  const order = initialColumnOrder(section, prefs);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    ref.current?.querySelector<HTMLElement>("[role='menuitemcheckbox']")?.focus();
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const toggle = (id: string) => {
    const next = { ...visible, [id]: !visible[id] };
    onPrefsChange(
      withPref(
        prefs,
        "hidden",
        section.columns.filter((c) => next[c.id] === false).map((c) => c.id),
      ),
    );
  };
  const reset = () => {
    let next = withPref(prefs, "hidden", undefined);
    next = withPref(next, "columnOrder", undefined);
    onPrefsChange(withPref(next, "widths", undefined));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div className="popover-anchor" ref={ref}>
      <button
        ref={button}
        type="button"
        className="toolbar-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={l10n.t("Show or hide columns")}
        onClick={() => setOpen((o) => !o)}
      >
        <Codicon name="list-selection" />
        <span>{l10n.t("Columns")}</span>
      </button>
      {open && (
        <div className="popover menu" role="menu" aria-label={l10n.t("Columns")} onKeyDown={onKeyDown}>
          {order.map((id) => {
            const col = section.columns.find((c) => c.id === id);
            if (!col) return null;
            return (
              <button
                key={id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={visible[id] !== false}
                className="menu-item"
                tabIndex={-1}
                onClick={() => toggle(id)}
              >
                <Codicon name={visible[id] !== false ? "check" : "blank"} />
                <span className="menu-title">{col.title}</span>
              </button>
            );
          })}
          <hr className="menu-separator" />
          <button type="button" role="menuitem" className="menu-item" tabIndex={-1} onClick={reset}>
            <Codicon name="discard" />
            <span className="menu-title">{l10n.t("Reset columns")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
