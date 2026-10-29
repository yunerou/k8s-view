import type {
  ContextPanelState,
  StatusLevel,
  TableCell,
  TableColumn,
  TableRow,
  TableSection,
  TableViewModel,
} from "../../../src/shared/protocol";

export const columns: TableColumn[] = [
  { id: "ready", title: "Ready", render: "text", hidden: false },
  { id: "phase", title: "Phase", render: "status", hidden: false },
  { id: "age", title: "Age", render: "age", hidden: false },
  { id: "images", title: "Images", render: "badge", hidden: true },
];

export function cell(text: string, sort: string | number | null = text, extra: Partial<TableCell> = {}): TableCell {
  return { text, sort, ...extra };
}

export function row(
  uid: string,
  opts: {
    name?: string;
    namespace?: string;
    level?: StatusLevel;
    kind?: string;
    ready?: number | null;
    labels?: Record<string, string>;
    groupKey?: string;
  } = {},
): TableRow {
  const ready = opts.ready === undefined ? 1 : opts.ready;
  return {
    uid,
    group: "apps",
    kind: opts.kind ?? "Deployment",
    name: opts.name ?? uid,
    namespace: opts.namespace ?? "default",
    level: opts.level ?? "ok",
    summary: undefined,
    cells: [
      cell(ready === null ? "" : `${ready}/1`, ready),
      cell("Running", "Running", { level: opts.level ?? "ok" }),
      cell("", 0, { timestamp: Date.parse("2026-10-20T00:00:00Z") }),
      cell("nginx", "nginx", { badges: ["nginx:1.27"] }),
    ],
    labels: opts.labels ?? {},
    ...(opts.groupKey === undefined ? {} : { groupKey: opts.groupKey }),
  };
}

export function section(id: string, rows: TableRow[], extra: Partial<TableSection> = {}): TableSection {
  return {
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    columns,
    showNamespace: true,
    state: "ready",
    problems: [],
    rows,
    ...extra,
  };
}

export function model(sections: TableSection[], extra: Partial<TableViewModel> = {}): TableViewModel {
  return {
    viewId: "workload",
    title: "Workload",
    context: "kind-dev",
    scope: { type: "all" },
    sections,
    prefs: {},
    hotkeys: { enabled: false, bindings: [], favorites: [] },
    ...extra,
  };
}

export function contextState(extra: Partial<ContextPanelState> = {}): ContextPanelState {
  return {
    contexts: [
      { name: "kind-dev", cluster: "kind", user: "admin", isKubeconfigCurrent: true, isProtected: false },
      { name: "prod", cluster: "prod-eu", user: "ops", isKubeconfigCurrent: false, isProtected: true },
    ],
    selected: "kind-dev",
    scope: { type: "all" },
    namespaces: ["default", "kube-system"],
    namespacesForbidden: false,
    connection: { state: "connected", serverVersion: "v1.34.1" },
    watch: { state: "live", watches: 3, errors: 0 },
    autoRefresh: true,
    refreshMode: "watch",
    pollIntervalSeconds: 10,
    ...extra,
  };
}
