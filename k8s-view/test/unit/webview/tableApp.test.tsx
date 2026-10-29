// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveHotkeys } from "../../../src/shared/hotkeys";
import type { RowDetails, TableWebviewState } from "../../../src/shared/protocol";
import { TableApp } from "../../../webview-ui/table/TableApp";
import { stubLayout } from "./dom";
import { model, row, section } from "./fixtures";
import { messengerModule, notify, requests, resetMessenger, respond, setInitialState } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);

const details: RowDetails = {
  overview: [{ label: "Replicas", value: "3" }],
  yaml: "apiVersion: apps/v1\nkind: Deployment\n",
  events: [{ type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 3, lastTimestamp: undefined }],
  conditions: [{ type: "Available", status: "True" }],
  related: [{ title: "Pods", items: [{ kind: "Pod", name: "web-1", namespace: "default", level: "ok" }] }],
};

const vm = model([section("deployments", [row("a"), row("b")]), section("pods", [row("p1"), row("p2"), row("p3")])]);

beforeAll(() => stubLayout());
beforeEach(() => {
  resetMessenger();
  respond.mockImplementation((method) => {
    if (method === "table/getViewModel") return vm;
    if (method === "table/details") return details;
    if (method === "table/commandsFor") return [];
    if (method === "table/saveToConfig") return "/ws/.vscode/k8s-view/workload.json";
    return undefined;
  });
});
afterEach(cleanup);

const bodyUids = () =>
  screen
    .getAllByRole("row")
    .filter((r) => r.closest("[data-part='body']"))
    .map((r) => r.getAttribute("data-uid"));

describe("TableApp", () => {
  test("renders rows of the first section and switches tabs", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    expect(bodyUids()).toEqual(["a", "b"]);
    fireEvent.click(screen.getByRole("tab", { name: /Pods/ }));
    expect(bodyUids()).toEqual(["p1", "p2", "p3"]);
    expect(screen.getByRole("tab", { name: /Pods/ }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() =>
      expect(messengerModule.setWebviewState).toHaveBeenLastCalledWith({
        viewId: "workload",
        prefs: {},
        activeSection: "pods",
      }),
    );
  });

  test("restores the active tab from webview state", async () => {
    setInitialState({
      viewId: "workload",
      activeSection: "pods",
      prefs: { pods: { filter: "p2" } },
    } satisfies TableWebviewState);
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Pods/ });
    expect(bodyUids()).toEqual(["p2"]);
  });

  test("applies patches: upsert, remove, reorder, problems and loading", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    notify("table/patch", {
      sectionId: "deployments",
      upserts: [row("c", { level: "warning" })],
      removes: ["a"],
      state: "loading",
      problems: ["deployments.apps is forbidden"],
      order: ["c", "b"],
    });
    expect(bodyUids()).toEqual(["c", "b"]);
    expect(screen.getAllByRole("row").find((r) => r.getAttribute("data-uid") === "c")!.className).toContain("flash");
    expect(screen.getByRole("alert").textContent).toContain("forbidden");
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  test("reset replaces the model", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    notify("table/reset", model([section("deployments", [row("z")])], { context: "prod" }));
    expect(bodyUids()).toEqual(["z"]);
    expect(screen.queryByRole("tab", { name: /Pods/ })).toBeNull();
  });

  test("Enter opens the detail drawer with YAML in a <pre>", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    const cell = within(screen.getAllByRole("row").find((r) => r.getAttribute("data-uid") === "b")!).getAllByRole(
      "gridcell",
    )[2]!;
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: /Details of Deployment default\/b/ });
    expect(requests("table/details")).toEqual([{ sectionId: "deployments", uid: "b" }]);
    await within(drawer).findByText("Replicas");
    fireEvent.click(within(drawer).getByRole("tab", { name: "YAML" }));
    expect(drawer.querySelector("pre")?.textContent).toContain("kind: Deployment");
    fireEvent.click(within(drawer).getByRole("tab", { name: /Events/ }));
    expect(within(drawer).getByText("BackOff")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("toolbar: group by, save to config and debounced savePrefs", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "namespace" } });
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("aria-expanded") !== null)).toHaveLength(1);
    await waitFor(() =>
      expect(requests("table/savePrefs")).toEqual([{ sectionId: "deployments", prefs: { groupBy: "namespace" } }]),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save to config/ }));
    expect(requests("table/saveToConfig")).toEqual([{ sectionId: "deployments", prefs: { groupBy: "namespace" } }]);
    expect(await screen.findByText(/Saved column layout to \/ws/)).toBeTruthy();
  });

  test("column menu hides a column", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Phase" }));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Phase");
  });

  test("right-click opens the context menu for the row", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    fireEvent.contextMenu(screen.getAllByRole("row").find((r) => r.getAttribute("data-uid") === "a")!);
    await screen.findByRole("menu", { name: "Resource actions" });
    expect(requests("table/commandsFor")).toEqual([{ sectionId: "deployments", uids: ["a"] }]);
  });
});

describe("TableApp hotkeys", () => {
  const hotkeys = {
    enabled: true,
    bindings: resolveHotkeys([{ key: "g", action: { command: "flux.reconcile" } }]),
    favorites: ["", "FluxCD"],
  };
  const errorVm = model(
    [
      section("deployments", [row("a"), row("b", { level: "error" }), row("c"), row("d", { level: "error" })]),
      section("pods", [row("p1")]),
    ],
    { hotkeys },
  );
  const cellOf = (uid: string) =>
    within(screen.getAllByRole("row").find((r) => r.getAttribute("data-uid") === uid)!).getAllByRole("gridcell")[2]!;
  const forwarded = vi.fn();
  const press = (target: Element, init: KeyboardEventInit) => fireEvent.keyDown(target, init);

  beforeEach(() => {
    forwarded.mockClear();
    window.addEventListener("keydown", forwarded);
    respond.mockImplementation((method) => (method === "table/getViewModel" ? errorVm : undefined));
  });
  afterEach(() => window.removeEventListener("keydown", forwarded));

  test("a bound key is handled and not forwarded to VS Code; unbound keys pass through", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    expect(screen.getByText("Hotkeys ON")).toBeTruthy();
    act(() => cellOf("a").focus());
    press(cellOf("a"), { key: "2", code: "Digit2" });
    expect(requests("table/hotkey")).toEqual([{ action: { favorite: 2 }, sectionId: "deployments", uids: ["a"] }]);
    expect(forwarded).not.toHaveBeenCalled();
    press(cellOf("a"), { key: "z", code: "KeyZ" });
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  test("shift+digit is unbound; custom command bindings go to the extension with the selected rows", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    fireEvent.click(screen.getAllByRole("row").find((r) => r.getAttribute("data-uid") === "c")!);
    press(cellOf("c"), { key: "!", code: "Digit1", shiftKey: true });
    press(cellOf("c"), { key: "g", code: "KeyG" });
    expect(requests("table/hotkey")).toEqual([
      { action: { command: "flux.reconcile" }, sectionId: "deployments", uids: ["c"] },
    ]);
  });

  test("typing in the filter box is never a hotkey", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    const filter = screen.getByRole("searchbox", { name: "Filter rows" });
    press(filter, { key: "2", code: "Digit2" });
    expect(requests("table/hotkey")).toEqual([]);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  test("OFF mode ignores hotkeys until the extension turns them on", async () => {
    respond.mockImplementation((method) =>
      method === "table/getViewModel" ? { ...errorVm, hotkeys: { ...hotkeys, enabled: false } } : undefined,
    );
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    press(cellOf("a"), { key: "]", code: "BracketRight" });
    expect(screen.getByRole("tab", { name: /Deployments/ }).getAttribute("aria-selected")).toBe("true");
    notify("table/hotkeys", hotkeys);
    press(cellOf("a"), { key: "]", code: "BracketRight" });
    expect(screen.getByRole("tab", { name: /Pods/ }).getAttribute("aria-selected")).toBe("true");
  });

  test("e / shift+e jump between error rows", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    const selected = () =>
      screen
        .getAllByRole("row")
        .filter((r) => r.getAttribute("aria-selected") === "true")
        .map((r) => r.getAttribute("data-uid"));
    press(cellOf("a"), { key: "e", code: "KeyE" });
    expect(selected()).toEqual(["b"]);
    press(cellOf("b"), { key: "e", code: "KeyE" });
    expect(selected()).toEqual(["d"]);
    press(cellOf("d"), { key: "e", code: "KeyE" });
    expect(selected()).toEqual(["b"]);
    press(cellOf("b"), { key: "E", code: "KeyE", shiftKey: true });
    expect(selected()).toEqual(["d"]);
  });

  test("? lists the bindings; / focuses the filter; d opens details", async () => {
    render(<TableApp />);
    await screen.findByRole("tab", { name: /Deployments/ });
    press(cellOf("a"), { key: "?", code: "Slash", shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Table hotkeys" });
    expect(within(help).getByText("shift+0")).toBeTruthy();
    expect(within(help).queryByText("shift+1")).toBeNull();
    expect(within(help).getByText("Favorite view 1 (empty)")).toBeTruthy();
    expect(within(help).getByText("Favorite view 2: FluxCD")).toBeTruthy();
    expect(within(help).getByText("Run command flux.reconcile")).toBeTruthy();
    fireEvent.keyDown(help, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    press(cellOf("a"), { key: "/", code: "Slash" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter rows" }));
    press(cellOf("a"), { key: "d", code: "KeyD" });
    await screen.findByRole("complementary", { name: /Details of Deployment default\/a/ });
  });
});
