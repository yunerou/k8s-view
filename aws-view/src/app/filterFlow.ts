import { isRegionCode } from "../core/aws/regions";
import { describeFilter, formatTagFilter, parseTagFilter } from "../core/ec2/filters";
import type { InstanceState } from "../core/ec2/model";
import type { PickItem, Prompter } from "./ports/Prompter";
import type { Selection } from "./Selection";

type FilterAction = "tag" | "removeTag" | "state" | "name" | "pinned" | "clear";
const STATES: readonly InstanceState[] = ["running", "stopped", "pending", "stopping"];
const OTHER_REGION = "\u0000other";

export async function editFilter(prompter: Prompter, selection: Selection): Promise<void> {
  const f = selection.filter();
  const items: PickItem<FilterAction>[] = [
    { label: "$(tag) Add tag filter…", description: f.tags.map(formatTagFilter).join(", ") || "none", value: "tag" },
    ...(f.tags.length > 0 ? [{ label: "$(close) Remove tag filter…", value: "removeTag" as const }] : []),
    { label: "$(vm) State…", description: f.states.join(", ") || "any", value: "state" },
    { label: "$(search) Name contains…", description: f.nameContains || "any", value: "name" },
    { label: f.pinnedOnly ? "$(pinned) Show all instances" : "$(pin) Show pinned instances only", value: "pinned" },
    { label: "$(clear-all) Clear filter", value: "clear" },
  ];
  const action = await prompter.pick(items, {
    title: "Filter instances",
    placeholder: describeFilter(f) ?? "No filter",
  });
  switch (action) {
    case "tag": {
      const text = await prompter.input({
        title: "Tag filter",
        prompt: "Key=value, several values separated by |, or only the key to match instances that have the tag",
        placeholder: "Owner=alice",
        validate: (v) => (parseTagFilter(v) ? undefined : "Enter Key or Key=value"),
      });
      const tag = text === undefined ? undefined : parseTagFilter(text);
      if (tag) await selection.setFilter({ ...f, tags: [...f.tags.filter((t) => t.key !== tag.key), tag] });
      return;
    }
    case "removeTag": {
      const key = await prompter.pick(
        f.tags.map((t) => ({ label: formatTagFilter(t), value: t.key })),
        { title: "Remove tag filter" },
      );
      if (key !== undefined) await selection.setFilter({ ...f, tags: f.tags.filter((t) => t.key !== key) });
      return;
    }
    case "state": {
      const state = await prompter.pick<InstanceState | "any">(
        [{ label: "Any state", value: "any" }, ...STATES.map((s) => ({ label: s, value: s }))],
        { title: "Instance state" },
      );
      if (state !== undefined) await selection.setFilter({ ...f, states: state === "any" ? [] : [state] });
      return;
    }
    case "name": {
      const name = await prompter.input({
        title: "Name contains",
        value: f.nameContains,
        placeholder: "Part of the Name tag or of the instance ID",
      });
      if (name !== undefined) await selection.setFilter({ ...f, nameContains: name.trim() });
      return;
    }
    case "pinned":
      await selection.setFilter({ ...f, pinnedOnly: !f.pinnedOnly });
      return;
    case "clear":
      await selection.clearFilter();
      return;
  }
}

export async function pickRegion(prompter: Prompter, selection: Selection): Promise<void> {
  const current = selection.region();
  const picked = await prompter.pick(
    [
      ...selection.regionChoices().map((r) => ({ label: r === current ? `$(check) ${r}` : r, value: r })),
      { label: "$(edit) Other region…", value: OTHER_REGION },
    ],
    { title: "AWS region", placeholder: current ?? "Region" },
  );
  if (picked === undefined) return;
  const region =
    picked === OTHER_REGION
      ? await prompter.input({
          title: "AWS region",
          placeholder: "eu-west-1",
          validate: (v) => (isRegionCode(v.trim()) ? undefined : "Enter a region code such as eu-west-1"),
        })
      : picked;
  if (region) await selection.setRegion(region.trim());
}
