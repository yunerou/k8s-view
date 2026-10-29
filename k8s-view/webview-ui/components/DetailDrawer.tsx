import * as l10n from "@vscode/l10n";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useState } from "react";
import { type RowDetails, type StatusLevel, TableRequests } from "../../src/shared/protocol";
import { formatAge } from "../shared/format";
import { errorMessage, useNow } from "../shared/hooks";
import { request } from "../shared/messenger";
import { Codicon } from "./Codicon";
import { RelatedTree } from "./RelatedTree";
import { StatusDot } from "./StatusDot";
import { Tabs } from "./Tabs";

type DetailTab = "overview" | "yaml" | "events" | "conditions" | "related";

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 600;

export interface DetailDrawerProps {
  readonly sectionId: string;
  readonly uid: string;
  readonly title: string;
  readonly onClose: () => void;
}

function age(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? "" : formatAge(t, now);
}

function conditionLevel(status: string): StatusLevel {
  return status === "True" ? "ok" : status === "False" ? "warning" : "unknown";
}

/** Right-hand detail drawer: Overview / YAML / Events / Conditions / Related. */
export function DetailDrawer({ sectionId, uid, title, onClose }: DetailDrawerProps) {
  const [details, setDetails] = useState<RowDetails>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<DetailTab>("overview");
  // Narrow windows: initially use at most 60% of the width (still resizable up to 85%).
  const [width, setWidth] = useState(() => Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, window.innerWidth * 0.6)));
  const [reload, setReload] = useState(0);
  const now = useNow(30_000);

  useEffect(
    () => () => {
      void request(TableRequests.closeRelated, { key: `table:details:${uid}`, dispose: true });
    },
    [uid],
  );

  useEffect(() => {
    let alive = true;
    setError(undefined);
    request(TableRequests.details, { sectionId, uid }).then(
      (d) => alive && setDetails(d),
      (e: unknown) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [sectionId, uid, reload]);

  const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth * 0.85);
  const onResizeStart = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: globalThis.PointerEvent) =>
      setWidth(Math.min(maxWidth(), Math.max(MIN_WIDTH, startW + startX - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") setWidth((w) => Math.min(maxWidth(), w + step));
    else if (e.key === "ArrowRight") setWidth((w) => Math.max(MIN_WIDTH, w - step));
    else return;
    e.preventDefault();
  };

  const tabs = [
    { id: "overview", label: l10n.t("Overview") },
    { id: "yaml", label: l10n.t("YAML") },
    { id: "events", label: l10n.t("Events"), count: details?.events.length },
    { id: "conditions", label: l10n.t("Conditions"), count: details?.conditions.length },
    { id: "related", label: l10n.t("Related"), count: details?.related.reduce((n, g) => n + g.items.length, 0) },
  ];

  return (
    <aside
      className="drawer"
      style={{ width }}
      aria-label={l10n.t("Details of {0}", title)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: draggable separator, not an <hr>. */}
      <div
        className="drawer-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={l10n.t("Resize details")}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
      />
      <header className="drawer-header">
        <h2 className="drawer-title" title={title}>
          {title}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label={l10n.t("Commands")}
          title={l10n.t("Commands")}
          onClick={() =>
            request(TableRequests.pickCommand, { sectionId, uids: [uid] }).catch((e: unknown) =>
              setError(errorMessage(e)),
            )
          }
        >
          <Codicon name="run-all" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={l10n.t("Reload details")}
          title={l10n.t("Reload details")}
          onClick={() => setReload((n) => n + 1)}
        >
          <Codicon name="refresh" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={l10n.t("Close details")}
          title={l10n.t("Close")}
          onClick={onClose}
        >
          <Codicon name="close" />
        </button>
      </header>
      <Tabs
        items={tabs}
        active={tab}
        onChange={(t) => setTab(t as DetailTab)}
        label={l10n.t("Detail tabs")}
        idPrefix="detail"
      />
      <div className="drawer-body" role="tabpanel" id="detail-panel" aria-labelledby={`detail-tab-${tab}`}>
        {error && (
          <div className="banner banner-error" role="alert">
            <Codicon name="error" />
            <div className="banner-body">{error}</div>
          </div>
        )}
        {!details && !error && (
          <div className="muted" role="status">
            {l10n.t("Loading…")}
          </div>
        )}
        {details && tab === "overview" && (
          <dl className="overview">
            {details.overview.map((o) => (
              <div key={o.label} className="overview-item">
                <dt>{o.label}</dt>
                <dd>{o.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {details && tab === "yaml" && (
          <pre className="yaml">
            <code>{details.yaml}</code>
          </pre>
        )}
        {details && tab === "events" && (
          <DetailTable
            empty={l10n.t("No events.")}
            head={[l10n.t("Type"), l10n.t("Reason"), l10n.t("Message"), l10n.t("Count"), l10n.t("Last seen")]}
            rows={details.events.map((e) => [
              <span key="t" className={e.type === "Warning" ? "text-warning" : ""}>
                {e.type}
              </span>,
              e.reason,
              e.message,
              String(e.count),
              age(e.lastTimestamp, now),
            ])}
          />
        )}
        {details && tab === "conditions" && (
          <DetailTable
            empty={l10n.t("No conditions.")}
            head={[l10n.t("Type"), l10n.t("Status"), l10n.t("Reason"), l10n.t("Message"), l10n.t("Age")]}
            rows={details.conditions.map((c) => [
              c.type,
              <span key="s" className="cell-status">
                <StatusDot level={conditionLevel(c.status)} label={c.status} />
                {c.status}
              </span>,
              c.reason ?? "",
              c.message ?? "",
              age(c.lastTransitionTime, now),
            ])}
          />
        )}
        {details && tab === "related" && (
          <RelatedTree key={reload} nodeKey={`table:details:${uid}`} initial={details.related} />
        )}
      </div>
    </aside>
  );
}

function DetailTable({
  head,
  rows,
  empty,
}: {
  readonly head: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
  readonly empty: string;
}) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="detail-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
