import type { JobAction } from "../../src/core/gitlab/actions";
import { statusLabel } from "../../src/core/gitlab/status";
import { formatDuration } from "../../src/core/util/format";
import { FullViewRequests, type JobRow } from "../../src/shared/protocol";
import { Codicon } from "../components/Codicon";
import { StatusIcon } from "../components/StatusIcon";
import { request } from "../shared/messenger";

const JOB_ACTION: Record<JobAction, { readonly label: string; readonly icon: string }> = {
  play: { label: "Run", icon: "play" },
  retry: { label: "Retry", icon: "refresh" },
  cancel: { label: "Cancel", icon: "debug-stop" },
};

export function openLog(repoId: string, job: { readonly id: number; readonly name: string }): void {
  void request(FullViewRequests.openLog, { repoId, jobId: job.id, jobName: job.name });
}

export function JobList({
  repoId,
  stages,
}: {
  readonly repoId: string;
  readonly stages: readonly { readonly stage: string; readonly jobs: readonly JobRow[] }[];
}) {
  if (stages.length === 0) return <p className="muted">No jobs</p>;
  return (
    <div className="job-list">
      {stages.map((g) => (
        <section key={g.stage} aria-label={`Stage ${g.stage}`}>
          <h3 className="stage-title">{g.stage}</h3>
          <ul>
            {g.jobs.map((j) => (
              <li key={j.id} className="job">
                <StatusIcon status={j.status} allowFailure={j.allowFailure} />
                <button
                  type="button"
                  className="link"
                  aria-label={`Open log of ${j.name}`}
                  onClick={() => openLog(repoId, j)}
                >
                  {j.name}
                </button>
                <span className="muted">
                  {statusLabel(j.status)}
                  {j.duration !== undefined ? ` · ${formatDuration(j.duration)}` : ""}
                </span>
                <span className="spacer" />
                {j.actions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className="icon-button"
                    title={`${JOB_ACTION[a].label} ${j.name}`}
                    aria-label={`${JOB_ACTION[a].label} ${j.name}`}
                    onClick={() =>
                      void request(FullViewRequests.action, {
                        kind: "job",
                        repoId,
                        jobId: j.id,
                        jobName: j.name,
                        action: a,
                      })
                    }
                  >
                    <Codicon name={JOB_ACTION[a].icon} />
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
