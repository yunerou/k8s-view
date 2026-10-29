import { useEffect, useState } from "react";
import { FullViewNotifications, FullViewRequests, type FullViewState } from "../../src/shared/protocol";
import { Banner } from "../components/Banner";
import { onNotification, request } from "../shared/messenger";
import { DetailPane } from "./DetailPane";
import { PipelineSection } from "./PipelineSection";
import { Toolbar } from "./Toolbar";

export function PipelineApp() {
  const [state, setState] = useState<FullViewState>();

  useEffect(() => {
    let alive = true;
    const off = onNotification(FullViewNotifications.state, setState);
    // State pushed before getState responds is newer: keep it.
    void request(FullViewRequests.getState).then((s) => {
      if (alive) setState((current) => current ?? s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!state) return <p className="muted app">Loading…</p>;
  const showHeaders = state.selection === "all" || state.sections.length > 1;
  return (
    <div className="app">
      <Toolbar state={state} />
      {state.repos.length === 0 && <Banner kind="info">No GitLab repository found in this workspace.</Banner>}
      <div className={state.detail ? "layout split" : "layout"}>
        <main className="sections">
          {state.sections.map((section) => {
            const repo = state.repos.find((r) => r.id === section.repoId);
            if (!repo) return null;
            return (
              <PipelineSection
                key={section.repoId}
                section={section}
                repo={repo}
                now={state.now}
                showHeader={showHeaders}
                selectedId={state.detail?.repoId === repo.id ? state.detail.pipelineId : undefined}
              />
            );
          })}
        </main>
        {state.detail && <DetailPane detail={state.detail} now={state.now} />}
      </div>
    </div>
  );
}
