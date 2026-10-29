// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { SectionPrefs, TableSection } from "../../../src/shared/protocol";
import { ResourceGrid } from "../../../webview-ui/components/ResourceGrid";
import { stubLayout } from "./dom";
import { row, section } from "./fixtures";

beforeAll(() => stubLayout());
afterEach(cleanup);

function Harness(props: {
  section: TableSection;
  prefs?: SectionPrefs;
  showFilters?: boolean;
  onPrefs?: (p: SectionPrefs) => void;
  onContextMenu?: (uids: string[]) => void;
  onOpenDetails?: (uid: string) => void;
}) {
  const [prefs, setPrefs] = useState<SectionPrefs>(props.prefs ?? {});
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  return (
    <ResourceGrid
      section={props.section}
      prefs={prefs}
      onPrefsChange={(p) => {
        setPrefs(p);
        props.onPrefs?.(p);
      }}
      showFilters={props.showFilters ?? false}
      selection={selection}
      onSelectionChange={setSelection}
      flash={new Set(["b"])}
      onContextMenu={(uids) => props.onContextMenu?.(uids)}
      onOpenDetails={(uid) => props.onOpenDetails?.(uid)}
    />
  );
}

const bodyRows = () => screen.getAllByRole("row").filter((r) => r.closest("[data-part='body']"));
/** Group rows display as `#<key><count>`. */
const names = () => bodyRows().map((r) => r.getAttribute("data-uid") ?? `#${r.textContent}`);

const rows = [
  row("a", { namespace: "team-a", ready: 2 }),
  row("b", { namespace: "team-b", ready: null, level: "error" }),
  row("c", { namespace: "team-a", ready: 1, labels: { app: "web" } }),
];

describe("ResourceGrid", () => {
  test("renders rows in model order with visible columns only", () => {
    render(<Harness section={section("deployments", rows)} />);
    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("4");
    expect(names()).toEqual(["a", "b", "c"]);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Name", "Namespace", "Ready", "Phase", "Age"]));
    expect(headers).not.toContain("Images");
    expect(bodyRows()[1]!.className).toContain("flash");
    expect(within(bodyRows()[1]!).getAllByRole("img", { name: "Error" })).toHaveLength(2);
  });

  test("hides the namespace column when showNamespace is false", () => {
    render(<Harness section={section("deployments", rows, { showNamespace: false })} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Namespace");
  });

  test("sorts by cell.sort with nulls last in both directions", () => {
    const onPrefs = vi.fn();
    render(<Harness section={section("deployments", rows)} onPrefs={onPrefs} />);
    const ready = screen.getByRole("columnheader", { name: /Ready/ });
    fireEvent.click(ready);
    expect(names()).toEqual(["c", "a", "b"]);
    expect(ready.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(ready);
    expect(names()).toEqual(["a", "c", "b"]);
    expect(onPrefs).toHaveBeenLastCalledWith({ sort: { id: "ready", desc: true } });
  });

  test("groups rows with counts and collapses a group", () => {
    render(<Harness section={section("deployments", rows)} prefs={{ groupBy: "namespace" }} />);
    expect(names()).toEqual(["#team-a2", "a", "c", "#team-b1", "b"]);
    const group = bodyRows()[0]!;
    expect(group.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(group).getByRole("gridcell"));
    expect(names()).toEqual(["#team-a2", "#team-b1", "b"]);
  });

  test("applies the global filter from prefs and per-column filters", () => {
    render(<Harness section={section("deployments", rows)} prefs={{ filter: "app=web" }} />);
    expect(names()).toEqual(["c"]);
    cleanup();
    render(<Harness section={section("deployments", rows)} showFilters />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Namespace" }), { target: { value: "team-b" } });
    expect(names()).toEqual(["b"]);
  });

  test("click, ctrl-click and shift-click select rows", () => {
    render(<Harness section={section("deployments", rows)} />);
    const [ra, rb, rc] = bodyRows();
    fireEvent.click(ra!);
    expect(ra!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(rc!, { ctrlKey: true });
    expect(bodyRows().map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false", "true"]);
    fireEvent.click(rb!, { shiftKey: true });
    expect(bodyRows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "true"]);
  });

  test("keyboard: arrows move focus, Space selects, Enter opens details, Shift+F10 opens the menu", () => {
    const onOpenDetails = vi.fn();
    const onContextMenu = vi.fn();
    render(
      <Harness section={section("deployments", rows)} onOpenDetails={onOpenDetails} onContextMenu={onContextMenu} />,
    );
    const first = within(bodyRows()[0]!).getAllByRole("gridcell")[2]!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const focused = document.activeElement as HTMLElement;
    expect(focused.closest("[role='row']")?.getAttribute("data-uid")).toBe("b");
    expect(focused.tabIndex).toBe(0);
    fireEvent.keyDown(focused, { key: " " });
    expect(bodyRows()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(focused, { key: "Enter" });
    expect(onOpenDetails).toHaveBeenCalledWith("b");
    fireEvent.keyDown(focused, { key: "F10", shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledWith(["b"]);
  });

  test("right-click selects the row and opens the menu with the selection", () => {
    const onContextMenu = vi.fn();
    render(<Harness section={section("deployments", rows)} onContextMenu={onContextMenu} />);
    fireEvent.click(bodyRows()[0]!);
    fireEvent.click(bodyRows()[2]!, { metaKey: true });
    fireEvent.contextMenu(bodyRows()[2]!);
    expect(onContextMenu).toHaveBeenLastCalledWith(["a", "c"]);
    fireEvent.contextMenu(bodyRows()[1]!);
    expect(onContextMenu).toHaveBeenLastCalledWith(["b"]);
  });
});

test("Pod configuration warning remains visible with hidden resource columns, is searchable, and clears on update", () => {
  const pod = { ...row("p", { kind: "Pod" }), group: "", resourceWarnings: ["Missing CPU request: app."] };
  const { rerender } = render(<Harness section={section("pods", [pod])} prefs={{ filter: "missing CPU request" }} />);
  expect(names()).toEqual(["p"]);
  const warning = screen.getByRole("img", { name: /Resource configuration warning/ });
  expect(warning.getAttribute("title")).toBe("Missing CPU request: app.");
  expect(warning.className).toContain("text-warning");
  expect(bodyRows()[0]!.className).toContain("level-ok");
  rerender(
    <Harness section={section("pods", [{ ...pod, resourceWarnings: [] }])} prefs={{ filter: "missing CPU request" }} />,
  );
  expect(screen.queryByRole("img", { name: /Resource configuration warning/ })).toBeNull();
  expect(names()).toEqual([]);
});

describe("column drag boundaries", () => {
  function drag(header: HTMLElement, clientX: number) {
    const event = new MouseEvent("dragstart", { bubbles: true, cancelable: true, clientX });
    const transfer = { setData: vi.fn(), effectAllowed: "" };
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    fireEvent(header, event);
    return { event, transfer };
  }

  test("the resize edge never starts a reorder, including after the pointer moves inward", () => {
    render(<Harness section={section("deployments", rows)} />);
    const ready = screen.getByRole("columnheader", { name: /Ready/ });
    vi.spyOn(ready, "getBoundingClientRect").mockReturnValue({ left: 100, width: 100 } as DOMRect);
    expect(drag(ready, 107).event.defaultPrevented).toBe(true);
    expect(drag(ready, 195).event.defaultPrevented).toBe(true);
    fireEvent.mouseDown(ready, { clientX: 194 });
    expect(drag(ready, 150).event.defaultPrevented).toBe(true);
  });

  test("dragging from the middle reorders a movable column", () => {
    const onPrefs = vi.fn();
    render(<Harness section={section("deployments", rows)} onPrefs={onPrefs} />);
    const ready = screen.getByRole("columnheader", { name: /Ready/ });
    vi.spyOn(ready, "getBoundingClientRect").mockReturnValue({ left: 100, width: 100 } as DOMRect);
    fireEvent.mouseDown(ready, { clientX: 150 });
    const { event, transfer } = drag(ready, 150);
    expect(event.defaultPrevented).toBe(false);
    expect(transfer.setData).toHaveBeenCalledWith("application/x-k8s-view-column", "ready");
    fireEvent.drop(screen.getByRole("columnheader", { name: /Phase/ }));
    expect(onPrefs).toHaveBeenCalledWith({ columnOrder: ["phase", "ready", "age", "images"] });
  });
});
