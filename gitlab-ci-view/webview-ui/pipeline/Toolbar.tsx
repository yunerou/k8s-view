import { useEffect, useState } from "react";
import { PIPELINE_SOURCES, PIPELINE_STATUSES, sourceLabel } from "../../src/core/gitlab/filterOptions";
import type { FilterState } from "../../src/core/gitlab/model";
import { FullViewRequests, type FullViewState } from "../../src/shared/protocol";
import { Codicon } from "../components/Codicon";
import { VscodeCheckbox, VscodeOption, VscodeSingleSelect } from "../components/vsc";
import { eventChecked, eventValue } from "../shared/events";
import { request } from "../shared/messenger";

export function Toolbar({ state }: { readonly state: FullViewState }) {
  const f = state.filters;
  const [refName, setRefName] = useState(f.refName ?? "");
  useEffect(() => setRefName(f.refName ?? ""), [f.refName]);
  const selectedRepo = state.repos.find((r) => r.id === state.selection);
  const setFilters = (patch: Partial<FilterState>) =>
    void request(FullViewRequests.setFilters, { filters: { ...f, ...patch } });
  return (
    <div className="toolbar" role="toolbar" aria-label="Pipeline filters">
      <VscodeSingleSelect
        aria-label="Repository"
        value={state.selection}
        onChange={(e) => void request(FullViewRequests.select, { selection: eventValue(e) })}
      >
        <VscodeOption value="all">All repositories</VscodeOption>
        {state.repos.map((r) => (
          <VscodeOption key={r.id} value={r.id}>
            {r.name}
          </VscodeOption>
        ))}
      </VscodeSingleSelect>
      <VscodeSingleSelect
        aria-label="Ref scope"
        value={f.ref}
        onChange={(e) =>
          setFilters({
            ref: eventValue(e) === "tags" ? "tags" : eventValue(e) === "all" ? "all" : "current",
            refName: "",
          })
        }
      >
        <VscodeOption value="current">Current branch</VscodeOption>
        <VscodeOption value="all">All branches and tags</VscodeOption>
        <VscodeOption value="tags">Tags (latest per tag)</VscodeOption>
      </VscodeSingleSelect>
      <form
        className="ref-search"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ ref: "all", refName: refName.trim() });
        }}
      >
        <input
          aria-label="Branch or tag name"
          placeholder="Branch or tag (exact name)"
          value={refName}
          onChange={(e) => setRefName(e.target.value)}
        />
        <button type="submit">Search ref</button>
      </form>
      <VscodeSingleSelect aria-label="Status" value={f.status} onChange={(e) => setFilters({ status: eventValue(e) })}>
        <VscodeOption value="">Any status</VscodeOption>
        {PIPELINE_STATUSES.map((s) => (
          <VscodeOption key={s} value={s}>
            {s}
          </VscodeOption>
        ))}
      </VscodeSingleSelect>
      <VscodeSingleSelect
        aria-label="Trigger event"
        value={f.source}
        onChange={(e) => {
          const source = eventValue(e);
          setFilters({ source, ...(source === "merge_request_event" && f.ref === "current" ? { ref: "all" } : {}) });
        }}
      >
        <VscodeOption value="">Any event</VscodeOption>
        {PIPELINE_SOURCES.map((s) => (
          <VscodeOption key={s} value={s}>
            {sourceLabel(s)}
          </VscodeOption>
        ))}
      </VscodeSingleSelect>
      <VscodeCheckbox label="Only mine" checked={f.mine} onChange={(e) => setFilters({ mine: eventChecked(e) })} />
      <span className="spacer" />
      {selectedRepo?.token === "ok" && (
        <button type="button" onClick={() => void request(FullViewRequests.runPipeline, { repoId: selectedRepo.id })}>
          <Codicon name="run-all" /> Run pipeline
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        title="Refresh"
        aria-label="Refresh"
        onClick={() => void request(FullViewRequests.refresh)}
      >
        <Codicon name="refresh" />
      </button>
    </div>
  );
}
