import * as l10n from "@vscode/l10n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HotkeyAction, HotkeyState } from "../../src/shared/hotkeys";
import {
  type NamespaceScope,
  type SectionPrefs,
  TableNotifications,
  TableRequests,
  type TableViewModel,
  type TableWebviewState,
} from "../../src/shared/protocol";
import { Banner } from "../components/Banner";
import { Codicon } from "../components/Codicon";
import { ContextMenu } from "../components/ContextMenu";
import { DetailDrawer } from "../components/DetailDrawer";
import { HotkeyHelp } from "../components/HotkeyHelp";
import { type GridHandle, ResourceGrid } from "../components/ResourceGrid";
import { SectionToolbar } from "../components/SectionToolbar";
import { Tabs } from "../components/Tabs";
import { errorMessage, useDebounced, useNotification } from "../shared/hooks";
import { getWebviewState, request, setWebviewState } from "../shared/messenger";
import { applyPatch } from "./model";
import { useHotkeys } from "./useHotkeys";

const FLASH_MS = 1500;
const SAVE_PREFS_MS = 500;

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly sectionId: string;
  readonly uids: readonly string[];
}

interface DrawerState {
  readonly sectionId: string;
  readonly uid: string;
}

function scopeLabel(scope: NamespaceScope | undefined): string {
  if (!scope) return "";
  return scope.type === "all" ? l10n.t("All namespaces") : scope.name;
}

export function TableApp() {
  const saved = useMemo(() => getWebviewState<TableWebviewState>(), []);
  const [model, setModel] = useState<TableViewModel>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [active, setActive] = useState(saved?.activeSection);
  const [prefs, setPrefs] = useState<Readonly<Record<string, SectionPrefs>>>(saved?.prefs ?? {});
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [menu, setMenu] = useState<MenuState>();
  const [drawer, setDrawer] = useState<DrawerState>();
  const [hotkeys, setHotkeys] = useState<HotkeyState>();
  const [showHelp, setShowHelp] = useState(false);
  const grid = useRef<GridHandle>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const viewId = useRef(saved?.viewId);

  const report = useCallback((e: unknown) => setError(errorMessage(e)), []);

  /** New model (initial load or reset): discard local preferences if the view has changed. */
  const adopt = useCallback((m: TableViewModel) => {
    if (viewId.current !== undefined && viewId.current !== m.viewId) {
      setPrefs({});
      setActive(undefined);
    }
    viewId.current = m.viewId;
    setModel(m);
    setHotkeys(m.hotkeys);
  }, []);

  useEffect(() => {
    request(TableRequests.getViewModel).then(adopt, report);
  }, [adopt, report]);

  useNotification(TableNotifications.reset, (m) => {
    adopt(m);
    setSelection(new Set());
    setMenu(undefined);
  });

  useNotification(TableNotifications.patch, (p) => {
    setModel((m) => m && applyPatch(m, p));
    if (p.removes.length > 0) {
      const gone = new Set(p.removes);
      setSelection((sel) => ([...sel].some((u) => gone.has(u)) ? new Set([...sel].filter((u) => !gone.has(u))) : sel));
      setDrawer((d) => (d && gone.has(d.uid) ? undefined : d));
    }
    if (p.upserts.length > 0) {
      setFlash((old) => new Set([...old, ...p.upserts.map((r) => r.uid)]));
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(new Set()), FLASH_MS);
    }
  });

  useNotification(TableNotifications.hotkeys, (h) => {
    setHotkeys(h);
    if (!h.enabled) setShowHelp(false);
  });

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const sections = model?.sections ?? [];
  const section = sections.find((s) => s.id === active) ?? sections[0];
  const activeId = section?.id;

  useEffect(() => {
    if (!model) return;
    setWebviewState<TableWebviewState>({
      viewId: model.viewId,
      prefs,
      ...(activeId === undefined ? {} : { activeSection: activeId }),
    });
  }, [model?.viewId, activeId, prefs, model]);

  const savePrefs = useDebounced((sectionId: string, p: SectionPrefs) => {
    request(TableRequests.savePrefs, { sectionId, prefs: p }).catch(report);
  }, SAVE_PREFS_MS);

  const prefsFor = (id: string): SectionPrefs => prefs[id] ?? model?.prefs[id] ?? {};

  const changePrefs = (id: string, p: SectionPrefs) => {
    setPrefs((old) => ({ ...old, [id]: p }));
    savePrefs(id, id, p);
  };

  const selectSection = (id: string) => {
    setActive(id);
    setSelection(new Set());
    setMenu(undefined);
    setDrawer(undefined);
  };

  /** Handle UI-only hotkeys locally; send view/namespace switches, commands, etc. to the extension. */
  const runHotkey = (action: HotkeyAction) => {
    if (activeId === undefined) return;
    const uids = grid.current?.targets() ?? [];
    const toExtension = () => request(TableRequests.hotkey, { action, sectionId: activeId, uids }).catch(report);
    if (!("action" in action)) {
      toExtension();
      return;
    }
    const step = (delta: number) => {
      const i = sections.findIndex((s) => s.id === activeId);
      const next = sections[(i + delta + sections.length) % sections.length];
      if (next) selectSection(next.id);
    };
    switch (action.action) {
      case "prevSection":
        return step(-1);
      case "nextSection":
        return step(1);
      case "focusFilter":
        return document.querySelector<HTMLInputElement>(".toolbar input[type='search']")?.focus();
      case "toggleFilters":
        return setShowFilters((v) => !v);
      case "nextError":
        return grid.current?.jumpTo("error", 1);
      case "prevError":
        return grid.current?.jumpTo("error", -1);
      case "details":
        if (uids[0]) setDrawer({ sectionId: activeId, uid: uids[0] });
        return;
      case "manifest":
        if (uids[0]) request(TableRequests.openManifest, { sectionId: activeId, uid: uids[0] }).catch(report);
        return;
      case "commands":
        return grid.current?.openMenu();
      case "refresh":
        request(TableRequests.refresh).catch(report);
        return;
      case "help":
        return setShowHelp(true);
      case "none":
        return;
      default:
        toExtension();
    }
  };
  useHotkeys(hotkeys, runHotkey);

  const closeMenu = useCallback(() => setMenu(undefined), []);
  const openMenu = useCallback(
    (sectionId: string, uids: string[], x: number, y: number) => setMenu({ sectionId, uids, x, y }),
    [],
  );

  if (!model || !section || activeId === undefined) {
    return (
      <div className="app table-app">
        {error ? (
          <Banner kind="error">{error}</Banner>
        ) : (
          <div className="muted loading-view" role="status">
            {model ? l10n.t("This view has no sections.") : l10n.t("Loading view…")}
          </div>
        )}
      </div>
    );
  }

  const sectionPrefs = prefsFor(activeId);
  const drawerRow = drawer
    ? model.sections.find((s) => s.id === drawer.sectionId)?.rows.find((r) => r.uid === drawer.uid)
    : undefined;

  return (
    <div className="app table-app">
      <header className="view-header">
        <h1>{model.title}</h1>
        <span className="muted">
          {[model.context ?? l10n.t("No context"), scopeLabel(model.scope)].filter(Boolean).join(" · ")}
        </span>
        {hotkeys?.enabled && (
          <button
            type="button"
            className="hotkey-badge"
            title={l10n.t("Hotkeys override VS Code keybindings in this table. Show the list (?)")}
            onClick={() => setShowHelp(true)}
          >
            <Codicon name="keyboard" />
            {l10n.t("Hotkeys ON")}
          </button>
        )}
      </header>
      {error && (
        <Banner kind="error" onDismiss={() => setError(undefined)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner kind="info" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Banner>
      )}
      <Tabs
        items={sections.map((s) => ({ id: s.id, label: s.title, icon: s.icon, count: s.rows.length }))}
        active={activeId}
        onChange={selectSection}
        label={l10n.t("Sections")}
        idPrefix="section"
      />
      <div className="section-panel" role="tabpanel" id="section-panel" aria-labelledby={`section-tab-${activeId}`}>
        <SectionToolbar
          section={section}
          prefs={sectionPrefs}
          onPrefsChange={(p) => changePrefs(activeId, p)}
          showFilters={showFilters}
          onToggleFilters={() => setShowFilters((v) => !v)}
          selected={selection.size}
          onSaveToConfig={() =>
            request(TableRequests.saveToConfig, { sectionId: activeId, prefs: sectionPrefs }).then(
              (path) => path && setNotice(l10n.t("Saved column layout to {0}", path)),
              report,
            )
          }
          onRefresh={() => request(TableRequests.refresh).catch(report)}
        />
        {section.state === "loading" && <div className="progress" role="progressbar" aria-label={l10n.t("Loading")} />}
        {section.problems.length > 0 && (
          <Banner kind="warning">
            <ul className="problems">
              {section.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Banner>
        )}
        <div className="section-content">
          <ResourceGrid
            key={activeId}
            section={section}
            prefs={sectionPrefs}
            onPrefsChange={(p) => changePrefs(activeId, p)}
            showFilters={showFilters}
            selection={selection}
            onSelectionChange={setSelection}
            flash={flash}
            onContextMenu={(uids, x, y) => openMenu(activeId, uids, x, y)}
            onOpenDetails={(uid) => setDrawer({ sectionId: activeId, uid })}
            handle={grid}
          />
          {drawer && (
            <DetailDrawer
              key={`${drawer.sectionId}/${drawer.uid}`}
              sectionId={drawer.sectionId}
              uid={drawer.uid}
              title={
                drawerRow
                  ? `${drawerRow.kind} ${drawerRow.namespace ? `${drawerRow.namespace}/` : ""}${drawerRow.name}`
                  : drawer.uid
              }
              onClose={() => setDrawer(undefined)}
            />
          )}
        </div>
      </div>
      {showHelp && hotkeys && (
        <HotkeyHelp bindings={hotkeys.bindings} favorites={hotkeys.favorites} onClose={() => setShowHelp(false)} />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sectionId={menu.sectionId}
          uids={menu.uids}
          onClose={closeMenu}
          onDetails={(uid) => setDrawer({ sectionId: menu.sectionId, uid })}
          onError={setError}
        />
      )}
    </div>
  );
}
