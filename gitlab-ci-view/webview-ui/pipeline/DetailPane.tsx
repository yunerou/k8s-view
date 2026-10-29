import { pipelineEvent } from "../../src/core/gitlab/filterOptions";
import { statusLabel } from "../../src/core/gitlab/status";
import { formatAge } from "../../src/core/util/format";
import { type DetailTab, FullViewRequests, type PipelineDetail } from "../../src/shared/protocol";
import { Banner } from "../components/Banner";
import { Codicon } from "../components/Codicon";
import { StatusIcon } from "../components/StatusIcon";
import { request } from "../shared/messenger";
import { DagView } from "./DagView";
import { JobList } from "./JobList";

export function DetailPane({ detail, now }: { readonly detail: PipelineDetail; readonly now: number }) {
  const p = detail.pipeline;
  const setTab = (tab: DetailTab) => void request(FullViewRequests.setTab, { tab });
  return (
    <aside className="detail" aria-label={`Pipeline #${detail.pipelineId}`}>
      <header className="detail-header">
        {p && <StatusIcon status={p.status} />}
        <strong>#{detail.pipelineId}</strong>
        {p && (
          <>
            <span>{p.ref}</span>
            <span className="muted">
              {statusLabel(p.status)} · {pipelineEvent(p)} · {formatAge(p.createdAt, now)}
            </span>
          </>
        )}
        <span className="spacer" />
        {p?.actions.map((a) => (
          <button
            key={a}
            type="button"
            className="icon-button"
            title={a === "retry" ? "Retry pipeline" : "Cancel pipeline"}
            aria-label={`${a === "retry" ? "Retry" : "Cancel"} pipeline #${p.id}`}
            onClick={() =>
              void request(FullViewRequests.action, {
                kind: "pipeline",
                repoId: detail.repoId,
                pipelineId: p.id,
                action: a,
              })
            }
          >
            <Codicon name={a === "retry" ? "refresh" : "debug-stop"} />
          </button>
        ))}
        {p && (
          <button
            type="button"
            className="icon-button"
            title="Open in browser"
            aria-label="Open in browser"
            onClick={() => void request(FullViewRequests.openUrl, { url: p.webUrl })}
          >
            <Codicon name="link-external" />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title="Close"
          aria-label="Close details"
          onClick={() => void request(FullViewRequests.closePipeline)}
        >
          <Codicon name="close" />
        </button>
      </header>
      {detail.error && <Banner kind="error">{detail.error}</Banner>}
      <div className="tabs" role="tablist" aria-label="Pipeline details">
        <button type="button" role="tab" aria-selected={detail.tab === "jobs"} onClick={() => setTab("jobs")}>
          Jobs
        </button>
        <button type="button" role="tab" aria-selected={detail.tab === "dag"} onClick={() => setTab("dag")}>
          DAG
        </button>
      </div>
      <div role="tabpanel" className="tab-body">
        {detail.loading && !p ? (
          <p className="muted">Loading…</p>
        ) : detail.tab === "jobs" ? (
          <JobList repoId={detail.repoId} stages={detail.stages} />
        ) : !detail.dag ? (
          <p className="muted">Loading graph…</p>
        ) : (
          <>
            {detail.dag.fallback && (
              <Banner kind="info">
                Showing stages only: job dependencies (needs) could not be loaded
                {detail.dag.error ? ` (${detail.dag.error})` : ""}.
              </Banner>
            )}
            <DagView repoId={detail.repoId} layout={detail.dag.layout} />
          </>
        )}
      </div>
    </aside>
  );
}
