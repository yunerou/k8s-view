import * as l10n from "@vscode/l10n";
import { useEffect, useState } from "react";
import { type RelatedGroup, type RelatedItem, TableNotifications, TableRequests } from "../../src/shared/protocol";
import { errorMessage, useNotification } from "../shared/hooks";
import { request } from "../shared/messenger";
import { Codicon } from "./Codicon";
import { StatusDot } from "./StatusDot";

export function RelatedTree({
  nodeKey,
  initial,
}: {
  readonly nodeKey: string;
  readonly initial?: readonly RelatedGroup[];
}) {
  const [groups, setGroups] = useState(initial);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useNotification(TableNotifications.relatedChanged, () => setRevision((n) => n + 1));
  useEffect(
    () => () => {
      void request(TableRequests.closeRelated, { key: nodeKey });
    },
    [nodeKey],
  );
  useEffect(() => {
    let alive = true;
    request(TableRequests.related, { key: nodeKey }).then(
      (value) => {
        if (alive) {
          setGroups(value);
          setError(undefined);
        }
      },
      (e: unknown) => {
        if (alive) setError(errorMessage(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [nodeKey, revision]);
  return (
    <div className="related">
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {!groups && !error && (
        <p role="status" className="muted">
          {l10n.t("Loading…")}
        </p>
      )}
      {groups?.length === 0 && <p className="muted">{l10n.t("No related resources.")}</p>}
      {groups?.map((group) => (
        <section key={group.key ?? group.title}>
          <h3>{group.title}</h3>
          {group.hints?.map((hint) => (
            <p key={hint} className="muted">
              {hint}
            </p>
          ))}
          {group.pending && (
            <p role="status" className="muted">
              {l10n.t("Loading…")}
            </p>
          )}
          {!group.pending && group.items.length === 0 && <p className="muted">{l10n.t("No related resources.")}</p>}
          <ul>
            {group.items.map((item) => (
              <RelatedResource key={item.key ?? `${item.kind}/${item.namespace ?? ""}/${item.name}`} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function RelatedResource({ item }: { readonly item: RelatedItem }) {
  const [open, setOpen] = useState(false);
  const label = (
    <>
      {item.icon ? (
        <span style={item.color ? { color: `var(--vscode-${item.color.replaceAll(".", "-")})` } : undefined}>
          <Codicon name={item.icon} />
        </span>
      ) : (
        <StatusDot level={item.level} />
      )}
      <span className="related-kind">{item.kind}</span>
      <span className="related-name">{item.namespace ? `${item.namespace}/${item.name}` : item.name}</span>
      {item.description && <span className="muted">{item.description}</span>}
    </>
  );
  return (
    <li>
      {item.expandable && item.key ? (
        <details
          onToggle={(e) => {
            const expanded = e.currentTarget.open;
            setOpen(expanded);
            if (!expanded) void request(TableRequests.closeRelated, { key: item.key! });
          }}
        >
          <summary>{label}</summary>
          {open && <RelatedTree nodeKey={item.key} />}
        </details>
      ) : (
        <div className="related-leaf">{label}</div>
      )}
    </li>
  );
}
