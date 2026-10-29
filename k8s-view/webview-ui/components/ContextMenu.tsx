import * as l10n from "@vscode/l10n";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CommandItem, TableRequests } from "../../src/shared/protocol";
import { errorMessage } from "../shared/hooks";
import { request } from "../shared/messenger";
import { Codicon } from "./Codicon";

export interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly sectionId: string;
  readonly uids: readonly string[];
  readonly onClose: () => void;
  readonly onDetails: (uid: string) => void;
  readonly onError: (message: string) => void;
}

interface Entry {
  readonly key: string;
  readonly title: string;
  readonly icon?: string | undefined;
  readonly disabled: boolean;
  readonly dangerous?: boolean;
  readonly hint?: string;
  readonly run: () => void;
}

interface EntryGroup {
  readonly label: string | undefined;
  readonly entries: readonly Entry[];
}

const MENU_ROW_HEIGHT = 26;
const MENU_MARGIN = 4;

export function menuPlacement(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  rowHeight = MENU_ROW_HEIGHT,
) {
  const anchor = Math.max(MENU_MARGIN, Math.min(y, viewportHeight - MENU_MARGIN));
  const above = Math.max(0, anchor - MENU_MARGIN);
  const below = Math.max(0, viewportHeight - anchor - MENU_MARGIN);
  const down = height <= below || (height > above && below >= above);
  const available = down ? below : above;
  return {
    x: Math.max(MENU_MARGIN, Math.min(x, viewportWidth - width - MENU_MARGIN)),
    y: down ? anchor : Math.max(MENU_MARGIN, anchor - Math.min(height, available)),
    maxHeight: available,
    native: Math.max(above, below) < 15 * rowHeight,
  };
}

export function blockedHint(): string {
  return l10n.t("Blocked by settings: enable k8sView.commands.dangerous to run it");
}

/** Group commands by `group`, preserving their order of appearance. */
export function groupCommands(items: readonly CommandItem[]): { label: string | undefined; items: CommandItem[] }[] {
  const groups = new Map<string, CommandItem[]>();
  for (const c of items) {
    const key = c.group ?? "";
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  return [...groups].map(([label, list]) => ({ label: label || undefined, items: list }));
}

/** Table context menu: Details, Open manifest, and commands matching the selection. */
export function ContextMenu(props: ContextMenuProps) {
  const { sectionId, uids, onClose } = props;
  const [commands, setCommands] = useState<readonly CommandItem[]>();
  const [failed, setFailed] = useState<string>();
  const [pos, setPos] = useState(() => menuPlacement(props.x, props.y, 200, 0, window.innerWidth, window.innerHeight));
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const nativeOpened = useRef(false);
  closeRef.current = onClose;

  useEffect(() => {
    let alive = true;
    request(TableRequests.commandsFor, { sectionId, uids }).then(
      (c) => alive && setCommands(c),
      (e: unknown) => alive && setFailed(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [sectionId, uids]);

  // Close on outside click; restore the previous focus when closed.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const close = () => closeRef.current();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      if (previous?.isConnected && !nativeOpened.current) previous.focus();
    };
  }, []);

  // Keep the menu within the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rowHeight = el.querySelector<HTMLElement>(".menu-item")?.getBoundingClientRect().height || MENU_ROW_HEIGHT;
    const next = menuPlacement(
      props.x,
      props.y,
      r.width,
      el.scrollHeight || r.height,
      window.innerWidth,
      window.innerHeight,
      rowHeight,
    );
    setPos((p) =>
      p.x === next.x && p.y === next.y && p.maxHeight === next.maxHeight && p.native === next.native ? p : next,
    );
  }, [props.x, props.y, commands, failed]);

  useEffect(() => {
    if (!pos.native || nativeOpened.current) return;
    nativeOpened.current = true;
    request(TableRequests.pickCommand, { sectionId, uids }).then(
      (action) => {
        if (action === "details" && uids.length === 1) props.onDetails(uids[0]!);
      },
      (e: unknown) => props.onError(errorMessage(e)),
    );
    closeRef.current();
  }, [pos.native, sectionId, uids, props.onDetails, props.onError]);

  const single = uids.length === 1 ? uids[0] : undefined;
  const fixed: Entry[] = [
    {
      key: "details",
      title: l10n.t("Details"),
      icon: "info",
      disabled: single === undefined,
      run: () => single !== undefined && props.onDetails(single),
    },
    {
      key: "manifest",
      title: l10n.t("Open manifest"),
      icon: "file-code",
      disabled: single === undefined,
      run: () => {
        if (single !== undefined)
          request(TableRequests.openManifest, { sectionId, uid: single }).catch((e: unknown) =>
            props.onError(errorMessage(e)),
          );
      },
    },
  ];
  const groups: EntryGroup[] = single ? [{ label: undefined, entries: fixed }] : [];
  for (const g of groupCommands(commands ?? [])) {
    groups.push({
      label: g.label,
      entries: g.items.map((c) => ({
        key: `cmd:${c.id}`,
        title: c.title,
        icon: c.icon,
        disabled: c.blocked,
        dangerous: c.dangerous,
        ...(c.blocked ? { hint: blockedHint() } : c.dangerous ? { hint: l10n.t("Dangerous command") } : {}),
        run: () => {
          request(TableRequests.runCommand, { commandId: c.id, sectionId, uids }).catch((e: unknown) =>
            props.onError(errorMessage(e)),
          );
        },
      })),
    });
  }
  const flat = groups.flatMap((g) => g.entries);

  useEffect(() => {
    if (!pos.native) ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active, commands, pos.native]);

  const activate = (entry: Entry | undefined) => {
    if (!entry || entry.disabled) return;
    onClose();
    entry.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = Math.max(1, flat.length);
    switch (e.key) {
      case "ArrowDown":
        setActive((a) => (a + 1) % n);
        break;
      case "ArrowUp":
        setActive((a) => (a - 1 + n) % n);
        break;
      case "Home":
        setActive(0);
        break;
      case "End":
        setActive(n - 1);
        break;
      case "Escape":
      case "Tab":
        onClose();
        break;
      case "Enter":
      case " ":
        activate(flat[active]);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  let index = 0;
  if (pos.native) return null;
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={single ? l10n.t("Resource actions") : l10n.t("Batch Commands")}
      style={{ left: pos.x, top: pos.y, maxHeight: pos.maxHeight, maxWidth: "calc(100vw - 8px)" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {groups.map((g, gi) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA menu group, not a form fieldset.
        <div key={g.label ?? `group-${gi}`} role="group" aria-label={g.label} className="menu-group">
          {gi > 0 && <hr className="menu-separator" />}
          {g.label && (
            <div className="menu-group-label" aria-hidden="true">
              {g.label}
            </div>
          )}
          {g.entries.map((entry) => {
            const i = index++;
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                data-index={i}
                tabIndex={i === active ? 0 : -1}
                aria-disabled={entry.disabled}
                title={entry.hint}
                className={`menu-item${entry.dangerous ? " dangerous" : ""}${entry.disabled ? " disabled" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => activate(entry)}
              >
                <Codicon name={entry.icon ?? "blank"} />
                <span className="menu-title">{entry.title}</span>
                {entry.dangerous && <Codicon name="warning" className="menu-flag" />}
                {entry.disabled && entry.hint && <Codicon name="lock" className="menu-flag" />}
              </button>
            );
          })}
        </div>
      ))}
      {commands === undefined && !failed && (
        <div className="menu-status" role="status">
          <Codicon name="loading" className="codicon-modifier-spin" /> {l10n.t("Loading commands…")}
        </div>
      )}
      {failed && (
        <div className="menu-status error" role="alert">
          {failed}
        </div>
      )}
      {commands?.length === 0 && !single && (
        <div className="menu-status">{l10n.t("No batch commands for this selection.")}</div>
      )}
    </div>
  );
}
