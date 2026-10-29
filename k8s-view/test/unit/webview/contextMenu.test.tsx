// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandItem } from "../../../src/shared/protocol";
import { ContextMenu, menuPlacement } from "../../../webview-ui/components/ContextMenu";
import { requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);

const commands: CommandItem[] = [
  {
    id: "restart",
    title: "Rollout restart",
    group: "Rollout",
    icon: "debug-restart",
    dangerous: false,
    blocked: false,
  },
  { id: "scale", title: "Scale…", group: "Rollout", icon: "arrow-both", dangerous: false, blocked: false },
  { id: "delete", title: "Delete", group: "Danger", icon: "trash", dangerous: true, blocked: false },
  { id: "exec", title: "Exec into", group: "Danger", dangerous: true, blocked: true },
];

beforeEach(() => {
  resetMessenger();
  respond.mockImplementation((method) => (method === "table/commandsFor" ? commands : "ok"));
});
afterEach(cleanup);

function renderMenu(uids: string[] = ["u1"]) {
  const onClose = vi.fn();
  const onDetails = vi.fn();
  render(
    <ContextMenu
      x={10}
      y={10}
      sectionId="deployments"
      uids={uids}
      onClose={onClose}
      onDetails={onDetails}
      onError={vi.fn()}
    />,
  );
  return { onClose, onDetails };
}

describe("ContextMenu", () => {
  test("lists commands from commandsFor grouped by group", async () => {
    renderMenu(["u1", "u2"]);
    await screen.findByRole("menuitem", { name: "Rollout restart" });
    expect(requests("table/commandsFor")).toEqual([{ sectionId: "deployments", uids: ["u1", "u2"] }]);
    expect(screen.getByRole("group", { name: "Rollout" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Danger" })).toBeTruthy();
    const titles = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(titles).toEqual(["Rollout restart", "Scale…", "Delete", "Exec into"]);
    expect(screen.queryByRole("menuitem", { name: "Details" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Open manifest" })).toBeNull();
  });

  test("marks dangerous items and disables blocked ones with a hint", async () => {
    renderMenu();
    const exec = await screen.findByRole("menuitem", { name: "Exec into" });
    expect(exec.getAttribute("aria-disabled")).toBe("true");
    expect(exec.getAttribute("title")).toContain("k8sView.commands.dangerous");
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("dangerous");
    fireEvent.click(exec);
    expect(requests("table/runCommand")).toEqual([]);
  });

  test("selecting a command calls runCommand and closes", async () => {
    const { onClose } = renderMenu(["u1"]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rollout restart" }));
    expect(onClose).toHaveBeenCalled();
    expect(requests("table/runCommand")).toEqual([{ commandId: "restart", sectionId: "deployments", uids: ["u1"] }]);
  });

  test("fixed items open details and the manifest", async () => {
    const { onDetails } = renderMenu(["u1"]);
    await screen.findByRole("menuitem", { name: "Delete" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(onDetails).toHaveBeenCalledWith("u1");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open manifest" }));
    expect(requests("table/openManifest")).toEqual([{ sectionId: "deployments", uid: "u1" }]);
  });

  test("keyboard: arrows move, Enter activates, Escape closes", async () => {
    const { onClose } = renderMenu(["u1"]);
    await screen.findByRole("menuitem", { name: "Delete" });
    expect(document.activeElement?.textContent).toBe("Details");
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Rollout restart");
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(requests("table/runCommand")).toHaveLength(1);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("menu placement", () => {
  test("opens above or below the anchor and constrains the menu to available space", () => {
    expect(menuPlacement(20, 30, 200, 300, 800, 800)).toMatchObject({ x: 20, y: 30, native: false });
    expect(menuPlacement(790, 770, 200, 300, 800, 800)).toMatchObject({ x: 596, y: 470, native: false });
    expect(menuPlacement(20, 450, 200, 900, 800, 900)).toMatchObject({ y: 450, maxHeight: 446, native: false });
  });
  test("uses VS Code when neither side can hold 15 rows", () => {
    expect(menuPlacement(20, 300, 200, 100, 800, 600).native).toBe(true);
    expect(menuPlacement(20, 100, 200, 100, 800, 600).native).toBe(false);
  });
  test("small spaces open the native picker once with the entire selection", async () => {
    const height = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    try {
      renderMenu(["u1", "u2"]);
      await vi.waitFor(() =>
        expect(requests("table/pickCommand")).toEqual([{ sectionId: "deployments", uids: ["u1", "u2"] }]),
      );
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    }
  });
});
