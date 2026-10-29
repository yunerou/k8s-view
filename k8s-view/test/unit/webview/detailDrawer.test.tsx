// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RelatedGroup, RowDetails } from "../../../src/shared/protocol";
import { DetailDrawer } from "../../../webview-ui/components/DetailDrawer";
import { RelatedTree } from "../../../webview-ui/components/RelatedTree";
import { notify, requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);

const root: RelatedGroup[] = [
  {
    key: "root/pods",
    title: "Pods",
    items: [{ key: "root/pods/p1", kind: "Pod", name: "web-1", level: "ok", expandable: true }],
  },
];
const children: RelatedGroup[] = [
  {
    key: "root/pods/p1/containers",
    title: "Containers",
    items: [{ kind: "field", name: "app", description: "nginx", level: "unknown" }],
  },
];

beforeEach(() => {
  resetMessenger();
  respond.mockImplementation((method, params) => {
    if (method === "table/related") return (params as { key: string }).key === "root" ? root : children;
    if (method === "table/details")
      return { overview: [], yaml: "", events: [], conditions: [], related: root } satisfies RowDetails;
    return undefined;
  });
});
afterEach(cleanup);

describe("Related resources", () => {
  test("loads children only after expansion and releases the branch when collapsed", async () => {
    render(<RelatedTree nodeKey="root" initial={root} />);
    const parent = await screen.findByText("web-1");
    const details = parent.closest("details")!;
    expect(screen.queryByText("nginx")).toBeNull();
    expect(requests("table/related")).toEqual([{ key: "root" }]);
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    expect(await screen.findByText("nginx")).toBeTruthy();
    expect(requests("table/related")).toContainEqual({ key: "root/pods/p1" });
    details.open = false;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    await vi.waitFor(() => expect(screen.queryByText("nginx")).toBeNull());
    expect(requests("table/closeRelated")).toContainEqual({ key: "root/pods/p1" });
  });

  test("refreshes relations on live updates and reports fetch failures", async () => {
    render(<RelatedTree nodeKey="root" initial={root} />);
    await screen.findByText("web-1");
    respond.mockImplementation((method) => {
      if (method === "table/related") throw new Error("Forbidden");
    });
    notify("table/relatedChanged", undefined);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Forbidden");
  });

  test("the drawer exposes Commands and releases its own root on close", async () => {
    const result = render(<DetailDrawer sectionId="pods" uid="p1" title="Pod web-1" onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Commands" });
    expect(screen.queryByRole("button", { name: "Open manifest" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Commands" }));
    expect(requests("table/pickCommand")).toEqual([{ sectionId: "pods", uids: ["p1"] }]);
    result.unmount();
    expect(requests("table/closeRelated")).toContainEqual({ key: "table:details:p1", dispose: true });
  });
});
