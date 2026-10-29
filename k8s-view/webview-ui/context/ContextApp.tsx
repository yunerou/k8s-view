import * as l10n from "@vscode/l10n";
import { useCallback, useEffect, useState } from "react";
import {
  type ContextInfo,
  ContextNotifications,
  type ContextPanelState,
  ContextRequests,
} from "../../src/shared/protocol";
import { Banner } from "../components/Banner";
import { Codicon } from "../components/Codicon";
import { ConnectionLine, WatchLine } from "../components/ConnectionStatus";
import { NamespacePicker } from "../components/NamespacePicker";
import { RefreshControl } from "../components/RefreshControl";
import { errorMessage, useNotification } from "../shared/hooks";
import { request } from "../shared/messenger";

function contextLabel(c: ContextInfo): string {
  const marks = [c.isKubeconfigCurrent ? l10n.t("current") : "", c.isProtected ? l10n.t("protected") : ""].filter(
    Boolean,
  );
  return marks.length > 0 ? `${c.name} (${marks.join(", ")})` : c.name;
}

/** Context panel (sidebar): cluster/namespace selection, connection status, auto-refresh. Snippets have a separate section. */
export function ContextApp() {
  const [state, setState] = useState<ContextPanelState>();
  const [error, setError] = useState<string>();
  const report = useCallback((e: unknown) => setError(errorMessage(e)), []);

  useEffect(() => {
    request(ContextRequests.getState).then(setState, report);
  }, [report]);
  useNotification(ContextNotifications.state, setState);

  if (!state) {
    return (
      <div className="app context-app">
        {error ? (
          <Banner kind="error">{error}</Banner>
        ) : (
          <div className="muted" role="status">
            {l10n.t("Loading…")}
          </div>
        )}
      </div>
    );
  }

  const selected = state.contexts.find((c) => c.name === state.selected);
  const noContext = selected === undefined;

  return (
    <div className="app context-app">
      {state.loadError && (
        <Banner kind="error">
          <strong>{l10n.t("Could not load kubeconfig")}</strong>
          <div className="pre-wrap">{state.loadError}</div>
        </Banner>
      )}
      {error && (
        <Banner kind="error" onDismiss={() => setError(undefined)}>
          {error}
        </Banner>
      )}

      <div className="picker-row">
        <div className="field cluster-field">
          <label className="field-label" htmlFor="cluster-select">
            {l10n.t("Cluster")}
            {selected?.isProtected && (
              <span className="protected-badge" title={l10n.t("Protected context: commands ask for confirmation")}>
                <Codicon name="lock" /> {l10n.t("protected")}
              </span>
            )}
          </label>
          {state.contexts.length === 0 ? (
            <p className="muted">{l10n.t("No contexts found in kubeconfig.")}</p>
          ) : (
            <button
              type="button"
              id="cluster-select"
              className="cluster-button"
              aria-label={l10n.t("Cluster: {0}. Select cluster…", selected ? contextLabel(selected) : l10n.t("none"))}
              title={l10n.t("Select cluster…")}
              onClick={() => request(ContextRequests.pickContext).catch(report)}
            >
              <Codicon name="server-environment" />
              <span className="cluster-button-text">
                <span className="cluster-name">{selected ? contextLabel(selected) : l10n.t("Select cluster…")}</span>
                {selected && <span className="cluster-detail">{`${selected.cluster} · ${selected.user}`}</span>}
              </span>
              <Codicon name="chevron-down" />
            </button>
          )}
        </div>

        <NamespacePicker
          scope={state.scope}
          namespaces={state.namespaces}
          forbidden={state.namespacesForbidden}
          disabled={noContext}
          onSelect={(scope) => request(ContextRequests.selectNamespace, { scope }).catch(report)}
          onRefresh={() => request(ContextRequests.refreshNamespaces).catch(report)}
        />
      </div>

      {!noContext && (
        <div className="status-block">
          <ConnectionLine
            connection={state.connection}
            onReconnect={() => request(ContextRequests.reconnect).catch(report)}
            onCancel={() => request(ContextRequests.cancelConnection).catch(report)}
          />
          <WatchLine watch={state.watch} refreshMode={state.refreshMode} />
        </div>
      )}

      <RefreshControl
        autoRefresh={state.autoRefresh}
        refreshMode={state.refreshMode}
        pollIntervalSeconds={state.pollIntervalSeconds}
        onSelect={(value) => request(ContextRequests.setRefresh, { value }).catch(report)}
      />
    </div>
  );
}
