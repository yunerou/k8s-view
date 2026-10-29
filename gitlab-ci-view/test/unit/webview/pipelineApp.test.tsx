// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FullViewState } from "../../../src/shared/protocol";
import { PipelineApp } from "../../../webview-ui/pipeline/PipelineApp";
import { fullState, row } from "./fixtures";
import { notify, requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);
vi.mock("../../../webview-ui/components/vsc", async () => await import("./vscMock"));

let state: FullViewState;

beforeEach(() => {
  resetMessenger();
  state = fullState();
  respond.mockImplementation((method) => (method === "full/getState" ? state : undefined));
});
afterEach(cleanup);

async function renderApp() {
  render(<PipelineApp />);
  await screen.findByRole("button", { name: "Open pipeline #101" });
}

describe("PipelineApp", () => {
  test("lists pipelines of each repository with its own pager", async () => {
    await renderApp();
    const web = screen.getByRole("region", { name: "web" });
    expect(within(web).getAllByText("10m ago")).toHaveLength(2);
    expect(within(web).getByText("Page 1")).toBeTruthy();
    expect(within(web).getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(web).getByRole("button", { name: "Next" }));
    expect(requests("full/setPage")).toEqual([{ repoId: "w", page: 2 }]);
  });

  test("row actions and opening a pipeline", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pipeline #101" }));
    expect(requests("full/action")).toEqual([{ kind: "pipeline", repoId: "w", pipelineId: 101, action: "cancel" }]);
    expect(screen.getByRole("button", { name: "Retry pipeline #100" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open pipeline #100" }));
    expect(requests("full/openPipeline")).toEqual([{ repoId: "w", pipelineId: 100 }]);
    fireEvent.click(screen.getByRole("button", { name: "Open pipeline #101 in browser" }));
    expect(requests("full/openUrl")).toEqual([{ url: "https://gitlab.com/team/web/-/pipelines/1" }]);
  });

  test("a repository without a token offers Set token", async () => {
    await renderApp();
    const ops = screen.getByRole("region", { name: "ops" });
    expect(within(ops).getByText(/No token for git\.company\.vn\./)).toBeTruthy();
    fireEvent.click(within(ops).getByRole("button", { name: "Set token" }));
    expect(requests("full/setToken")).toEqual([{ host: "git.company.vn" }]);
  });

  test("toolbar changes selection and filters", async () => {
    await renderApp();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "w" } });
    expect(requests("full/select")).toEqual([{ selection: "w" }]);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "failed" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Only mine" }));
    expect(requests("full/setFilters")).toEqual([
      { filters: { ref: "current", status: "failed", source: "", mine: false } },
      { filters: { ref: "current", status: "", source: "", mine: true } },
    ]);
  });

  test("state pushed by the extension replaces the view", async () => {
    await renderApp();
    notify(
      "full/state",
      fullState({ sections: [{ repoId: "w", page: 1, hasNext: false, loading: false, rows: [row({ id: 200 })] }] }),
    );
    expect(await screen.findByRole("button", { name: "Open pipeline #200" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })?.hasAttribute("disabled")).toBe(true);
  });
});

test("shows tag and merge request trigger events", async () => {
  state = fullState({
    sections: [
      {
        repoId: "w",
        page: 1,
        hasNext: false,
        loading: false,
        rows: [row({ id: 101, tag: true, ref: "v1.2.3" }), row({ id: 102, source: "merge_request_event" })],
      },
    ],
  });
  await renderApp();
  expect(screen.getByText("Push · Tag")).toBeTruthy();
  expect(screen.getByText("Merge request", { selector: "td" })).toBeTruthy();
});

test("searches an exact tag only when the ref search form is submitted", async () => {
  await renderApp();
  fireEvent.change(screen.getByRole("textbox", { name: "Branch or tag name" }), { target: { value: "v1.2.3" } });
  expect(requests("full/setFilters")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Search ref" }));
  expect(requests("full/setFilters")).toEqual([
    { filters: { ref: "all", refName: "v1.2.3", source: "", status: "", mine: false } },
  ]);
});

test("queries tags from the ref scope selector", async () => {
  await renderApp();
  fireEvent.change(screen.getByRole("combobox", { name: "Ref scope" }), { target: { value: "tags" } });
  expect(requests("full/setFilters")[0]).toMatchObject({ filters: { ref: "tags", refName: "" } });
});
