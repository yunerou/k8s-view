/**
 * Typed protocol between the extension and webview (vscode-messenger). Shared by
 * `src/` (extension) and `webview-ui/`; contains only types and constants, with no `vscode` imports.
 */
import type { NotificationType, RequestType } from "vscode-messenger-common";
import type { HotkeyAction, HotkeyState } from "./hotkeys";

export type StatusLevel = "ok" | "warning" | "error" | "progress" | "unknown";
export type RenderKind =
  | "text"
  | "age"
  | "status"
  | "boolean"
  | "count"
  | "labels"
  | "quantity"
  | "badge"
  | "cpu"
  | "memory"
  | "percentage";
export type NamespaceScope = { readonly type: "single"; readonly name: string } | { readonly type: "all" };

// ───────────────────────── Context panel ─────────────────────────

export interface ContextInfo {
  readonly name: string;
  readonly cluster: string;
  readonly user: string;
  /** Kubeconfig's `current-context`. */
  readonly isKubeconfigCurrent: boolean;
  readonly isProtected: boolean;
}

export type ConnectionInfo =
  | { readonly state: "unknown" }
  /** `login`: waiting for the exec auth plugin to run in an interactive terminal. */
  | { readonly state: "connecting"; readonly login?: boolean }
  | { readonly state: "connected"; readonly serverVersion: string }
  | { readonly state: "error"; readonly message: string };

export interface WatchInfo {
  readonly state: "idle" | "live" | "polling" | "paused" | "error";
  readonly watches: number;
  readonly errors: number;
  readonly message?: string;
}

export type RefreshChoice = "pause" | "watch" | number;

export interface ContextPanelState {
  readonly contexts: readonly ContextInfo[];
  readonly selected: string | undefined;
  readonly scope: NamespaceScope | undefined;
  readonly namespaces: readonly string[];
  /** No permission to list namespaces: the list is only a suggestion; allow manual entry. */
  readonly namespacesForbidden: boolean;
  readonly connection: ConnectionInfo;
  readonly watch: WatchInfo;
  readonly autoRefresh: boolean;
  readonly refreshMode: "watch" | "poll" | "manual";
  readonly pollIntervalSeconds: number;
  readonly loadError?: string;
}

export const ContextRequests = {
  getState: { method: "context/getState" } as RequestType<void, ContextPanelState>,
  /** Open VS Code's context Quick Pick (enough room for long cluster names). */
  pickContext: { method: "context/pickContext" } as RequestType<void, void>,
  selectNamespace: { method: "context/selectNamespace" } as RequestType<{ scope: NamespaceScope }, void>,
  refreshNamespaces: { method: "context/refreshNamespaces" } as RequestType<void, void>,
  /** Reconnect; contexts using exec auth sign in again in the terminal. */
  reconnect: { method: "context/reconnect" } as RequestType<void, void>,
  cancelConnection: { method: "context/cancelConnection" } as RequestType<void, void>,
  /** `"pause"` = stop updates, `"watch"` = live, number = poll every N seconds (the latter two also resume if paused). */
  setRefresh: { method: "context/setRefresh" } as RequestType<{ value: RefreshChoice }, void>,
};

export const ContextNotifications = {
  /** Extension → webview: new state (small enough to push in full). */
  state: { method: "context/state" } as NotificationType<ContextPanelState>,
};

// ───────────────────────── Resource table ─────────────────────────

export interface TableCell {
  readonly text: string;
  readonly sort: string | number | null;
  readonly level?: StatusLevel;
  readonly tooltip?: string;
  /** `age` cell: the webview recalculates age from the timestamp (ms) every 30 s. */
  readonly timestamp?: number;
  readonly badges?: readonly string[];
}

export interface TableColumn {
  readonly id: string;
  readonly title: string;
  readonly render: RenderKind;
  readonly width?: number;
  readonly hidden: boolean;
}

export interface TableRow {
  /** Stable key: object UID. */
  readonly uid: string;
  readonly group: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace: string | undefined;
  readonly level: StatusLevel;
  readonly summary: string | undefined;
  /** Parallel to `TableSection.columns`. */
  readonly cells: readonly TableCell[];
  /** Configuration warnings, independent of runtime health and Metrics Server availability. */
  readonly resourceWarnings?: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  /** Group key based on the section's `groupBy` (if any). */
  readonly groupKey?: string;
  readonly creationTimestamp?: number;
}

export interface TableSection {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly columns: readonly TableColumn[];
  /** Show the Namespace column (All namespaces and namespaced kinds). */
  readonly showNamespace: boolean;
  readonly groupBy?: string;
  readonly state: "loading" | "ready";
  readonly problems: readonly string[];
  readonly rows: readonly TableRow[];
}

/** Table preferences per section, stored per view (workspaceState) and optionally written back to JSON. */
export interface SectionPrefs {
  readonly columnOrder?: readonly string[];
  readonly hidden?: readonly string[];
  readonly widths?: Readonly<Record<string, number>>;
  readonly sort?: { readonly id: string; readonly desc: boolean };
  readonly groupBy?: string;
  readonly filter?: string;
}

export interface TableViewModel {
  readonly viewId: string;
  readonly title: string;
  readonly context: string | undefined;
  readonly scope: NamespaceScope | undefined;
  readonly sections: readonly TableSection[];
  readonly prefs: Readonly<Record<string, SectionPrefs>>;
  readonly hotkeys: HotkeyState;
}

export interface TablePatch {
  readonly sectionId: string;
  /** Added or updated rows (by UID). */
  readonly upserts: readonly TableRow[];
  readonly removes: readonly string[];
  readonly state: "loading" | "ready";
  readonly problems: readonly string[];
  /** UID order after applying the patch (the view's default sort). */
  readonly order: readonly string[];
}

export interface CommandItem {
  readonly id: string;
  readonly title: string;
  readonly group?: string;
  readonly icon?: string;
  readonly dangerous: boolean;
  /** Blocked by `k8sView.commands.dangerous = restricted`: dimmed with a hint. */
  readonly blocked: boolean;
}

export interface RowRef {
  readonly sectionId: string;
  readonly uid: string;
}

export interface EventInfo {
  readonly type: string;
  readonly reason: string;
  readonly message: string;
  readonly count: number;
  readonly lastTimestamp: string | undefined;
}

export interface ConditionInfo {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime?: string;
}

export interface RelatedGroup {
  readonly key?: string;
  readonly title: string;
  readonly pending?: boolean;
  readonly hints?: readonly string[];
  readonly items: readonly RelatedItem[];
}

export interface RelatedItem {
  readonly key?: string;
  readonly expandable?: boolean;
  readonly icon?: string;
  readonly color?: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly level: StatusLevel;
  readonly description?: string;
}

export interface RowDetails {
  readonly overview: readonly { readonly label: string; readonly value: string }[];
  readonly yaml: string;
  readonly events: readonly EventInfo[];
  readonly conditions: readonly ConditionInfo[];
  readonly related: readonly RelatedGroup[];
}

export const TableRequests = {
  getViewModel: { method: "table/getViewModel" } as RequestType<void, TableViewModel>,
  commandsFor: { method: "table/commandsFor" } as RequestType<
    { sectionId: string; uids: readonly string[] },
    readonly CommandItem[]
  >,
  pickCommand: { method: "table/pickCommand" } as RequestType<
    { sectionId: string; uids: readonly string[] },
    "details" | undefined
  >,
  runCommand: {
    method: "table/runCommand",
  } as RequestType<
    { commandId: string; sectionId: string; uids: readonly string[] },
    "ok" | "cancelled" | "blocked" | "failed"
  >,
  details: { method: "table/details" } as RequestType<RowRef, RowDetails>,
  related: { method: "table/related" } as RequestType<{ key: string }, readonly RelatedGroup[]>,
  closeRelated: { method: "table/closeRelated" } as RequestType<{ key: string; dispose?: boolean }, void>,
  openManifest: { method: "table/openManifest" } as RequestType<RowRef, void>,
  savePrefs: { method: "table/savePrefs" } as RequestType<{ sectionId: string; prefs: SectionPrefs }, void>,
  /** Write differences (column order/visibility/width) to an override file; return its path, or undefined on cancellation. */
  saveToConfig: { method: "table/saveToConfig" } as RequestType<
    { sectionId: string; prefs: SectionPrefs },
    string | undefined
  >,
  refresh: { method: "table/refresh" } as RequestType<void, void>,
  /** Hotkeys requiring extension handling (switch view/namespace, run commands on selected rows, Quick Pick). */
  hotkey: { method: "table/hotkey" } as RequestType<
    { action: HotkeyAction; sectionId: string; uids: readonly string[] },
    void
  >,
};

export const TableNotifications = {
  /** Extension → webview: replace the entire model (context/config changed). */
  reset: { method: "table/reset" } as NotificationType<TableViewModel>,
  /** Extension → webview: only added/updated/deleted rows by UID. */
  patch: { method: "table/patch" } as NotificationType<TablePatch>,
  /** Extension → webview: toggle hotkey mode or update bindings after config changes. */
  hotkeys: { method: "table/hotkeys" } as NotificationType<HotkeyState>,
  relatedChanged: { method: "table/relatedChanged" } as NotificationType<void>,
};

/** State saved via `vscode.setState` in the table webview; the serializer uses `viewId` to restore tabs after reload. */
export interface TableWebviewState {
  readonly viewId: string;
  readonly activeSection?: string;
  readonly prefs?: Readonly<Record<string, SectionPrefs>>;
}

export const TABLE_VIEW_TYPE = "k8sView.table";
