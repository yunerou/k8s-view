import * as l10n from "@vscode/l10n";
import { useMemo } from "react";
import type { SectionPrefs, TableSection } from "../../src/shared/protocol";
import { searchError } from "../table/gridColumns";
import { GROUP_NONE, groupByOptions, withPref } from "../table/model";
import { Codicon } from "./Codicon";
import { ColumnMenu } from "./ColumnMenu";

export interface SectionToolbarProps {
  readonly section: TableSection;
  readonly prefs: SectionPrefs;
  readonly onPrefsChange: (prefs: SectionPrefs) => void;
  readonly showFilters: boolean;
  readonly onToggleFilters: () => void;
  readonly selected: number;
  readonly onSaveToConfig: () => void;
  readonly onRefresh: () => void;
}

export function SectionToolbar(props: SectionToolbarProps) {
  const { section, prefs, onPrefsChange } = props;
  const groupBy = prefs.groupBy ?? section.groupBy ?? GROUP_NONE;
  const options = groupByOptions(section);
  if (!options.some((o) => o.value === groupBy)) options.push({ value: groupBy, label: groupBy });
  const activeFilters = Object.keys(prefs.columnFilters ?? {}).length;
  const searchProblem = useMemo(
    () => searchError(prefs.filter ?? "", section.columns),
    [prefs.filter, section.columns],
  );

  return (
    <div className="toolbar" role="toolbar" aria-label={l10n.t("{0} toolbar", section.title)}>
      <div className="search">
        <Codicon name="search" />
        <input
          type="search"
          className={searchProblem ? "input invalid" : "input"}
          placeholder={l10n.t("Filter {0}… (e.g. restarts:>0 age:<1h)", section.title)}
          aria-label={l10n.t("Filter rows")}
          aria-invalid={searchProblem ? true : undefined}
          title={searchProblem}
          value={prefs.filter ?? ""}
          onChange={(e) => onPrefsChange(withPref(prefs, "filter", e.target.value || undefined))}
        />
      </div>
      <button
        type="button"
        className="toolbar-button"
        aria-pressed={props.showFilters}
        title={activeFilters > 0 ? l10n.t("{0} column filters active", activeFilters) : l10n.t("Toggle column filters")}
        onClick={props.onToggleFilters}
      >
        <Codicon name={props.showFilters || activeFilters > 0 ? "filter-filled" : "filter"} />
        <span className="sr-only">{l10n.t("Column filters")}</span>
      </button>
      <label className="group-by">
        <span>{l10n.t("Group by")}</span>
        <select
          className="select"
          value={groupBy}
          onChange={(e) => onPrefsChange(withPref(prefs, "groupBy", e.target.value))}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <ColumnMenu section={section} prefs={prefs} onPrefsChange={onPrefsChange} />
      <span className="toolbar-spacer" />
      <span className="toolbar-count" aria-live="polite">
        {props.selected > 0
          ? l10n.t("{0} items · {1} selected", section.rows.length, props.selected)
          : l10n.t("{0} items", section.rows.length)}
      </span>
      <button
        type="button"
        className="toolbar-button"
        title={l10n.t("Save column layout to the view config file")}
        onClick={props.onSaveToConfig}
      >
        <Codicon name="save" />
        <span>{l10n.t("Save to config")}</span>
      </button>
      <button
        type="button"
        className="toolbar-button"
        title={l10n.t("Refresh")}
        aria-label={l10n.t("Refresh")}
        onClick={props.onRefresh}
      >
        <Codicon name="refresh" className={section.state === "loading" ? "codicon-modifier-spin" : undefined} />
      </button>
    </div>
  );
}
