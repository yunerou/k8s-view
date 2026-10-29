import type { PipelineAction } from "../../src/core/gitlab/actions";
import { pipelineEvent } from "../../src/core/gitlab/filterOptions";
import { statusLabel } from "../../src/core/gitlab/status";
import { formatAge } from "../../src/core/util/format";
import { FullViewRequests, type RepoInfo, type RepoSection } from "../../src/shared/protocol";
import { Banner } from "../components/Banner";
import { Codicon } from "../components/Codicon";
import { StatusIcon } from "../components/StatusIcon";
import { request } from "../shared/messenger";

const PIPELINE_ACTION: Record<PipelineAction, { readonly label: string; readonly icon: string }> = {
  retry: { label: "Retry", icon: "refresh" },
  cancel: { label: "Cancel", icon: "debug-stop" },
};

export function PipelineSection({
  section,
  repo,
  now,
  showHeader,
  selectedId,
}: {
  readonly section: RepoSection;
  readonly repo: RepoInfo;
  readonly now: number;
  readonly showHeader: boolean;
  readonly selectedId: number | undefined;
}) {
  const setPage = (page: number) => void request(FullViewRequests.setPage, { repoId: repo.id, page });
  return (
    <section className="repo-section" aria-label={repo.name}>
      {showHeader && (
        <h2 className="repo-header">
          <Codicon name="repo" />
          <span>{repo.name}</span>
          <span className="muted">
            {repo.projectPath}
            {repo.branch ? ` · ${repo.branch}` : ""}
          </span>
          <span className="spacer" />
          {repo.token === "ok" && (
            <button
              type="button"
              className="icon-button"
              title="Run pipeline"
              aria-label={`Run pipeline in ${repo.name}`}
              onClick={() => void request(FullViewRequests.runPipeline, { repoId: repo.id })}
            >
              <Codicon name="run-all" />
            </button>
          )}
        </h2>
      )}
      {repo.token !== "ok" ? (
        <Banner kind="warning">
          {repo.token === "missing" ? `No token for ${repo.host}.` : `The token for ${repo.host} was rejected.`}{" "}
          <button
            type="button"
            className="link"
            onClick={() => void request(FullViewRequests.setToken, { host: repo.host })}
          >
            Set token
          </button>
        </Banner>
      ) : (
        <>
          {section.error && <Banner kind="error">{section.error}</Banner>}
          <table className="pipelines">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Pipeline</th>
                <th scope="col">Ref</th>
                <th scope="col">Trigger event</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((p) => (
                <tr key={p.id} className={p.id === selectedId ? "selected" : undefined}>
                  <td>
                    <StatusIcon status={p.status} /> {statusLabel(p.status)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      aria-label={`Open pipeline #${p.id}`}
                      onClick={() => void request(FullViewRequests.openPipeline, { repoId: repo.id, pipelineId: p.id })}
                    >
                      #{p.id}
                    </button>
                  </td>
                  <td title={p.sha}>{p.ref}</td>
                  <td title={p.source}>{pipelineEvent(p)}</td>
                  <td title={p.createdAt}>{formatAge(p.createdAt, now)}</td>
                  <td className="actions">
                    {p.actions.map((a) => (
                      <button
                        key={a}
                        type="button"
                        className="icon-button"
                        title={`${PIPELINE_ACTION[a].label} pipeline`}
                        aria-label={`${PIPELINE_ACTION[a].label} pipeline #${p.id}`}
                        onClick={() =>
                          void request(FullViewRequests.action, {
                            kind: "pipeline",
                            repoId: repo.id,
                            pipelineId: p.id,
                            action: a,
                          })
                        }
                      >
                        <Codicon name={PIPELINE_ACTION[a].icon} />
                      </button>
                    ))}
                    <button
                      type="button"
                      className="icon-button"
                      title="Open in browser"
                      aria-label={`Open pipeline #${p.id} in browser`}
                      onClick={() => void request(FullViewRequests.openUrl, { url: p.webUrl })}
                    >
                      <Codicon name="link-external" />
                    </button>
                  </td>
                </tr>
              ))}
              {section.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {section.loading ? "Loading…" : "No pipelines match the filters"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <nav className="pager" aria-label={`Pages of ${repo.name}`}>
            <button type="button" disabled={section.page <= 1} onClick={() => setPage(section.page - 1)}>
              Previous
            </button>
            <span>Page {section.page}</span>
            <button type="button" disabled={!section.hasNext} onClick={() => setPage(section.page + 1)}>
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
