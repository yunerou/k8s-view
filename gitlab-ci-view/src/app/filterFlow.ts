import { PIPELINE_SOURCES, PIPELINE_STATUSES, sourceLabel } from "../core/gitlab/filterOptions";
import type { Prompter } from "./ports/Prompter";
import type { RepoSelection } from "./RepoSelection";

type Field = "refName" | "ref" | "status" | "source" | "mine" | "reset";

/** Quick Pick to change one filter at a time. */
export async function editFilters(prompter: Prompter, selection: RepoSelection): Promise<void> {
  const f = selection.filters;
  const field = await prompter.pick<Field>(
    [
      {
        label: "$(git-branch) Ref scope",
        description: f.ref === "current" ? "current branch" : f.ref === "tags" ? "latest per tag" : "all refs",
        value: "ref",
      },
      { label: "$(pulse) Status", description: f.status || "any", value: "status" },
      { label: "$(tag) Find branch or tag…", description: f.refName || "any ref", value: "refName" },
      { label: "$(zap) Trigger event", description: f.source ? sourceLabel(f.source) : "any", value: "source" },
      { label: "$(person) Only my pipelines", description: f.mine ? "on" : "off", value: "mine" },
      { label: "$(clear-all) Reset filters", value: "reset" },
    ],
    { title: "Filter pipelines" },
  );
  switch (field) {
    case "ref": {
      const ref = await prompter.pick<"current" | "all" | "tags">(
        [
          { label: "Current branch", value: "current" },
          { label: "All branches and tags", value: "all" },
          { label: "Tags (latest pipeline per tag)", value: "tags" },
        ],
        { title: "Pipeline ref scope" },
      );
      if (ref !== undefined) await selection.setFilters({ ...f, ref, refName: "" });
      return;
    }
    case "refName": {
      const name = await prompter.input({
        title: "Find pipelines by branch or tag",
        prompt: "Exact branch or tag name; leave empty to clear",
        value: f.refName ?? "",
        placeholder: "v1.2.3",
      });
      if (name !== undefined) await selection.setFilters({ ...f, ref: "all", refName: name.trim() });
      return;
    }
    case "mine":
      return selection.setFilters({ ...f, mine: !f.mine });
    case "reset":
      return selection.resetFilters();
    case "status": {
      const status = await pickValue(prompter, "Filter by status", "Any status", PIPELINE_STATUSES);
      if (status !== undefined) await selection.setFilters({ ...f, status });
      return;
    }
    case "source": {
      const source = await prompter.pick(
        [
          { label: "Any event", value: "" },
          ...PIPELINE_SOURCES.map((value) => ({ label: sourceLabel(value), description: value, value })),
        ],
        { title: "Filter by trigger event" },
      );
      if (source !== undefined)
        await selection.setFilters({
          ...f,
          source,
          ...(source === "merge_request_event" && f.ref === "current" ? { ref: "all" as const } : {}),
        });
      return;
    }
    default:
      return;
  }
}

function pickValue(
  prompter: Prompter,
  title: string,
  any: string,
  values: readonly string[],
): Promise<string | undefined> {
  return prompter.pick([{ label: any, value: "" }, ...values.map((v) => ({ label: v, value: v }))], { title });
}
