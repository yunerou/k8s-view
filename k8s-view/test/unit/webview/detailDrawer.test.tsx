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
      return { overview: [], yaml: "", events: [], conditions: [], related: root, parents: [] } satisfies RowDetails;
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

describe("Documentation", () => {
  const documentation = {
    kind: "Deployment",
    url: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
  };

  test("shows the official guide and asks the extension to open it", async () => {
    respond.mockResolvedValue({
      overview: [],
      yaml: "",
      events: [],
      conditions: [],
      related: [],
      parents: [],
      documentation,
    });
    render(<DetailDrawer sectionId="deployments" uid="d1" title="Deployment web" onClose={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Deployment guide" });
    expect(link.getAttribute("href")).toBe(documentation.url);
    fireEvent.click(link);
    expect(requests("table/openDocumentation")).toEqual([{ sectionId: "deployments", uid: "d1" }]);
  });

  test("omits documentation when the resource has no curated guide", async () => {
    render(<DetailDrawer sectionId="custom" uid="c1" title="Custom resource" onClose={vi.fn()} />);
    await screen.findByRole("tabpanel");
    await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText("Documentation")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("reports browser-opening failures", async () => {
    respond.mockImplementation((method) => {
      if (method === "table/details")
        return { overview: [], yaml: "", events: [], conditions: [], related: [], parents: [], documentation };
      if (method === "table/openDocumentation") throw new Error("Browser unavailable");
    });
    render(<DetailDrawer sectionId="deployments" uid="d1" title="Deployment web" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("link", { name: "Deployment guide" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Browser unavailable");
  });
});

describe("Parent tab", () => {
  const parents: RelatedGroup[] = [
    {
      key: "table:parents:p1/ReplicaSet",
      title: "ReplicaSet",
      items: [
        {
          key: "table:parents:p1/rs1",
          kind: "ReplicaSet",
          name: "web-1",
          level: "ok",
          description: "owner",
          expandable: true,
        },
      ],
    },
  ];
  const grandparents: RelatedGroup[] = [
    {
      key: "table:parents:p1/rs1/Deployment",
      title: "Deployment",
      items: [{ kind: "Deployment", name: "web", level: "ok" }],
    },
  ];

  beforeEach(() => {
    respond.mockImplementation((method, params) => {
      if (method === "table/details")
        return { overview: [], yaml: "", events: [], conditions: [], related: [], parents } satisfies RowDetails;
      if (method === "table/parents")
        return (params as { key: string }).key === "table:parents:p1" ? parents : grandparents;
      return undefined;
    });
  });

  test("shows parents with their relation and expands through table/parents", async () => {
    render(<DetailDrawer sectionId="pods" uid="p1" title="Pod web-1" onClose={vi.fn()} tab="parent" />);
    expect((await screen.findByRole("tab", { name: /Parent/ })).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("owner")).toBeTruthy();
    const details = (await screen.findByText("web-1")).closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    expect(await screen.findByText("web")).toBeTruthy();
    expect(requests("table/parents")).toContainEqual({ key: "table:parents:p1/rs1" });
  });

  test("Open in table opens the scoped tab for the current tab's direction", async () => {
    render(<DetailDrawer sectionId="pods" uid="p1" title="Pod web-1" onClose={vi.fn()} tab="parent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open in table" }));
    expect(requests("table/openScoped")).toEqual([{ sectionId: "pods", uid: "p1", direction: "parents" }]);
  });

  test("empty parents say so", async () => {
    respond.mockImplementation((method) =>
      method === "table/details"
        ? ({ overview: [], yaml: "", events: [], conditions: [], related: [], parents: [] } satisfies RowDetails)
        : [],
    );
    render(<DetailDrawer sectionId="pods" uid="p1" title="Pod web-1" onClose={vi.fn()} tab="parent" />);
    expect(await screen.findByText("No parents.")).toBeTruthy();
  });
});
