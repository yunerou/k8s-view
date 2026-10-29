import { DAG_METRICS, type DagLayout } from "../../src/core/dag/layout";
import { statusLabel, statusLevel } from "../../src/core/gitlab/status";
import { StatusIcon } from "../components/StatusIcon";
import { openLog } from "./JobList";

/** Pipeline graph: stage names above columns, `needs` edges as SVG paths, nodes as buttons opening logs. */
export function DagView({ repoId, layout }: { readonly repoId: string; readonly layout: DagLayout }) {
  const { nodeWidth: W, nodeHeight: H, padding: P } = DAG_METRICS;
  if (layout.nodes.length === 0) return <p className="muted">No jobs</p>;
  return (
    <div className="dag-scroll">
      <svg width={layout.width} height={layout.height}>
        <title>Pipeline graph</title>
        {layout.columns.map((c) => (
          <text key={c.stage} x={c.x} y={P + 14} className="dag-stage">
            {c.stage}
          </text>
        ))}
        {layout.edges.map((e) => (
          <path key={`${e.from}->${e.to}`} d={e.path} className="dag-edge" />
        ))}
        {layout.nodes.map((n) => (
          <foreignObject key={n.key} x={n.x} y={n.y} width={W} height={H}>
            <button
              type="button"
              className={`dag-job border-${statusLevel(n.status, n.allowFailure)}`}
              title={`${n.name} · ${statusLabel(n.status)}`}
              aria-label={`Open log of ${n.name}`}
              disabled={n.jobId === undefined}
              onClick={() => {
                if (n.jobId !== undefined) openLog(repoId, { id: n.jobId, name: n.name });
              }}
            >
              <StatusIcon status={n.status} allowFailure={n.allowFailure} />
              <span className="dag-job-name">{n.name}</span>
            </button>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
}
