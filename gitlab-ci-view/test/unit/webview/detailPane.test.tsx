// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { layoutDag } from "../../../src/core/dag/layout";
import { DetailPane } from "../../../webview-ui/pipeline/DetailPane";
import { PipelineApp } from "../../../webview-ui/pipeline/PipelineApp";
import { detail, fullState } from "./fixtures";
import { requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);
vi.mock("../../../webview-ui/components/vsc", async () => await import("./vscMock"));

const now = Date.parse("2026-10-29T10:10:00Z");

beforeEach(resetMessenger);
afterEach(cleanup);

describe("DetailPane", () => {
  test("jobs tab lists stages, jobs and job actions", () => {
    render(<DetailPane detail={detail()} now={now} />);
    const build = screen.getByRole("region", { name: "Stage build" });
    expect(within(build).getByText("success · 1m 05s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run prod" }));
    expect(requests("full/action")).toEqual([{ kind: "job", repoId: "w", jobId: 3, jobName: "prod", action: "play" }]);
    fireEvent.click(screen.getByRole("button", { name: "Open log of build" }));
    expect(requests("full/openLog")).toEqual([{ repoId: "w", jobId: 1, jobName: "build" }]);
  });

  test("header actions, tabs and close", () => {
    render(<DetailPane detail={detail()} now={now} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel pipeline #101" }));
    expect(requests("full/action")).toEqual([{ kind: "pipeline", repoId: "w", pipelineId: 101, action: "cancel" }]);
    fireEvent.click(screen.getByRole("tab", { name: "DAG" }));
    expect(requests("full/setTab")).toEqual([{ tab: "dag" }]);
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(requests("full/closePipeline")).toHaveLength(1);
  });

  test("DAG tab draws nodes and need edges; a node opens the job log", () => {
    const layout = layoutDag([
      { name: "build", jobs: [{ id: 1, name: "compile", status: "success", needs: [] }] },
      { name: "test", jobs: [{ id: 2, name: "unit", status: "failed", needs: ["compile"] }] },
    ]);
    const { container } = render(
      <DetailPane detail={detail({ tab: "dag", dag: { layout, fallback: false } })} now={now} />,
    );
    expect(container.querySelectorAll("path.dag-edge")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open log of unit" }));
    expect(requests("full/openLog")).toEqual([{ repoId: "w", jobId: 2, jobName: "unit" }]);
  });

  test("DAG fallback explains that needs are missing", () => {
    const layout = layoutDag([{ name: "build", jobs: [{ id: 1, name: "compile", status: "success", needs: [] }] }]);
    render(
      <DetailPane
        detail={detail({ tab: "dag", dag: { layout, fallback: true, error: "GraphQL disabled" } })}
        now={now}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Showing stages only");
    expect(screen.getByRole("status").textContent).toContain("GraphQL disabled");
  });

  test("PipelineApp shows the detail pane when a pipeline is open", async () => {
    respond.mockImplementation((method) => (method === "full/getState" ? fullState({ detail: detail() }) : undefined));
    render(<PipelineApp />);
    expect(await screen.findByRole("complementary", { name: "Pipeline #101" })).toBeTruthy();
  });
});
