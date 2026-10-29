import type { KubeResource } from "../core/resource/KubeResource";
import { podResourceWarnings } from "../core/resource/resourceAlerts";
import type { SectionDefinition } from "../core/view/ViewDefinition";
import type { TablePatch, TableRow, TableSection } from "../shared/protocol";
import type { SectionContent } from "./ViewSession";

/** What has been sent for a section, so only changes are sent. */
export interface SectionSnapshot {
  /** UID → row JSON signature. */
  readonly rows: ReadonlyMap<string, string>;
  /** `state` + `problems`: an empty section transitioning from loading → ready still needs a patch. */
  readonly meta: string;
}

export const EMPTY_SNAPSHOT: SectionSnapshot = { rows: new Map(), meta: "" };

export function buildRow(section: SectionDefinition, r: KubeResource, now: number): TableRow {
  const status = section.status(r);
  const created = r.creationTimestamp ? Date.parse(r.creationTimestamp) : undefined;
  const groupKey = section.groupKey(r);
  const resourceWarnings = podResourceWarnings(r);
  return {
    uid: r.uid,
    group: r.kind.group,
    kind: r.kind.kind,
    name: r.name,
    namespace: r.namespace,
    level: status.level,
    summary: status.summary,
    cells: section.columns.map((c) => c.evaluate(r, now)),
    labels: r.labels,
    ...(resourceWarnings.length > 0 ? { resourceWarnings } : {}),
    ...(groupKey !== undefined ? { groupKey } : {}),
    ...(created !== undefined && !Number.isNaN(created) ? { creationTimestamp: created } : {}),
  };
}

export function buildSection(
  section: SectionDefinition,
  content: SectionContent,
  allNamespaces: boolean,
  now: number,
): TableSection {
  return {
    id: section.id,
    title: section.title,
    ...(section.icon ? { icon: section.icon } : {}),
    columns: section.columns.map((c) => ({
      id: c.id,
      title: c.title,
      render: c.render,
      hidden: c.hidden,
      ...(c.width ? { width: c.width } : {}),
    })),
    showNamespace: (allNamespaces || section.allNamespaces) && content.items.some((r) => r.kind.namespaced),
    ...(section.groupBy ? { groupBy: section.groupBy } : {}),
    state: content.state,
    problems: content.problems.map((p) => `${p.kind}: ${p.message ?? p.state}`),
    rows: content.items.map((r) => buildRow(section, r, now)),
  };
}

/** Signature excluding time-dependent fields (age cell text); the webview calculates age from timestamps. */
function signature(row: TableRow): string {
  return JSON.stringify({ ...row, cells: row.cells.map((c) => (c.timestamp !== undefined ? { t: c.timestamp } : c)) });
}

export function diffSection(
  sectionId: string,
  previous: SectionSnapshot,
  next: TableSection,
): { patch: TablePatch; snapshot: SectionSnapshot; changed: boolean } {
  const rows = new Map<string, string>();
  const upserts: TableRow[] = [];
  for (const row of next.rows) {
    const sig = signature(row);
    rows.set(row.uid, sig);
    if (previous.rows.get(row.uid) !== sig) upserts.push(row);
  }
  const removes = [...previous.rows.keys()].filter((uid) => !rows.has(uid));
  const order = next.rows.map((r) => r.uid);
  const orderChanged = order.join("\n") !== [...previous.rows.keys()].join("\n");
  const meta = JSON.stringify([next.state, next.problems]);
  return {
    patch: { sectionId, upserts, removes, state: next.state, problems: next.problems, order },
    snapshot: { rows, meta },
    changed: upserts.length > 0 || removes.length > 0 || orderChanged || meta !== previous.meta,
  };
}
