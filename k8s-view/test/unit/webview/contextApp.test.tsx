// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ContextPanelState } from "../../../src/shared/protocol";
import { ContextApp } from "../../../webview-ui/context/ContextApp";
import { contextState } from "./fixtures";
import { notify, requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);
vi.mock("../../../webview-ui/components/vsc", async () => await import("./vscMock"));

let state: ContextPanelState;

beforeEach(() => {
  resetMessenger();
  state = contextState();
  respond.mockImplementation((method) => (method === "context/getState" ? state : undefined));
});
afterEach(cleanup);

async function renderPanel() {
  render(<ContextApp />);
  return await screen.findByRole("button", { name: /^Cluster: / });
}

describe("ContextApp", () => {
  test("the cluster button shows the full selected context and opens the VS Code picker", async () => {
    const cluster = await renderPanel();
    expect(cluster.getAttribute("aria-label")).toBe("Cluster: kind-dev (current). Select cluster…");
    expect(within(cluster).getByText("kind-dev (current)")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Cluster" })).toBeNull();
    fireEvent.click(cluster);
    expect(requests("context/pickContext")).toHaveLength(1);
  });

  test("namespace selector offers All namespaces and refresh", async () => {
    await renderPanel();
    const ns = screen.getByRole("combobox", { name: "Namespace" });
    expect(
      within(ns)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All namespaces", "default", "kube-system"]);
    fireEvent.change(ns, { target: { value: "kube-system" } });
    expect(requests("context/selectNamespace")).toEqual([{ scope: { type: "single", name: "kube-system" } }]);
    notify("context/state", { ...state, scope: { type: "single", name: "kube-system" } });
    fireEvent.change(ns, { target: { value: "*" } });
    expect(requests("context/selectNamespace")[1]).toEqual({ scope: { type: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh namespaces" }));
    expect(requests("context/refreshNamespaces")).toHaveLength(1);
  });

  test("allows typing a namespace when listing is forbidden", async () => {
    state = contextState({ namespacesForbidden: true, namespaces: [] });
    await renderPanel();
    expect(screen.getByText(/cannot list namespaces/i)).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Namespace name" });
    fireEvent.input(input, { target: { value: "Bad_NS" } });
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.input(input, { target: { value: "team-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(requests("context/selectNamespace")).toEqual([{ scope: { type: "single", name: "team-a" } }]);
  });

  test("cluster and namespace share the picker block", async () => {
    const cluster = await renderPanel();
    const ns = screen.getByRole("combobox", { name: "Namespace" });
    const row = cluster.closest(".picker-row");
    expect(row).toBeTruthy();
    expect(row?.contains(ns)).toBe(true);
  });

  test("connecting shows Cancel; sign-in waits for the terminal", async () => {
    state = contextState({ connection: { state: "connecting", login: true } });
    await renderPanel();
    expect(screen.getByText(/Waiting for sign-in in the terminal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(requests("context/cancelConnection")).toHaveLength(1);
    notify("context/state", { ...state, connection: { state: "connecting" } });
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });

  test("shows connection and watch status; retry on error", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(requests("context/reconnect")).toHaveLength(1);
    expect(screen.getByText(/Connected · v1\.34\.1/)).toBeTruthy();
    expect(screen.getByText(/Live · 3 watches/)).toBeTruthy();
    notify("context/state", {
      ...state,
      connection: { state: "error", message: "Unauthorized" },
      watch: { state: "error", watches: 1, errors: 2, message: "watch failed" },
    });
    expect(screen.getByText("Unauthorized")).toBeTruthy();
    expect(screen.getByText(/watch failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(requests("context/reconnect")).toHaveLength(2);
  });

  test("auto refresh is one row of radio buttons: Pause, Live, 3s, 5s, 10s", async () => {
    await renderPanel();
    const group = screen.getByRole("group", { name: "Auto refresh" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Pause", "Live", "3s", "5s", "10s"]);
    expect((screen.getByRole("radio", { name: "Live" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Refresh interval" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "5s" }));
    fireEvent.click(screen.getByRole("radio", { name: "Pause" }));
    // Already selected: do not resend.
    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    expect(requests("context/setRefresh")).toEqual([{ value: 5 }, { value: "pause" }]);

    notify("context/state", { ...state, autoRefresh: false });
    expect((screen.getByRole("radio", { name: "Pause" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    expect(requests("context/setRefresh")[2]).toEqual({ value: "watch" });

    // Custom intervals from settings are also shown to indicate the current selection.
    notify("context/state", { ...state, refreshMode: "poll", pollIntervalSeconds: 20 });
    expect((screen.getByRole("radio", { name: "20s" }) as HTMLInputElement).checked).toBe(true);
  });

  test("no follow toggle, kubectl context button or snippets (own section)", async () => {
    await renderPanel();
    expect(screen.queryByRole("checkbox", { name: "Follow Kubernetes extension" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set as kubectl current context" })).toBeNull();

    expect(screen.queryByRole("heading", { name: "Snippets" })).toBeNull();
  });

  test("shows loadError prominently", async () => {
    state = contextState({ loadError: "kubeconfig: invalid YAML", contexts: [], selected: undefined });
    render(<ContextApp />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("kubeconfig: invalid YAML");
  });
});
