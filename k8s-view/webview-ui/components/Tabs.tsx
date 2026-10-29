import { type KeyboardEvent, useId } from "react";
import { Codicon } from "./Codicon";

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string | undefined;
  readonly count?: number | undefined;
}

/** Tablist following the WAI-ARIA pattern: ←/→/Home/End switch tabs; only the selected tab receives Tab. */
export function Tabs({
  items,
  active,
  onChange,
  label,
  idPrefix,
}: {
  readonly items: readonly TabItem[];
  readonly active: string | undefined;
  readonly onChange: (id: string) => void;
  readonly label: string;
  readonly idPrefix?: string;
}) {
  const auto = useId();
  const prefix = idPrefix ?? auto;
  const index = Math.max(
    0,
    items.findIndex((t) => t.id === active),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    const item = items[next];
    if (!item) return;
    onChange(item.id);
    document.getElementById(`${prefix}-tab-${item.id}`)?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((t, i) => (
        <button
          key={t.id}
          id={`${prefix}-tab-${t.id}`}
          type="button"
          role="tab"
          className="tab"
          aria-selected={i === index}
          aria-controls={`${prefix}-panel`}
          tabIndex={i === index ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.icon && <Codicon name={t.icon} />}
          <span>{t.label}</span>
          {t.count !== undefined && <span className="count-badge">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function tabPanelId(prefix: string): string {
  return `${prefix}-panel`;
}
