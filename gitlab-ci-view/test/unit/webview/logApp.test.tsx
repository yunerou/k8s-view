// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { LogInit } from "../../../src/shared/protocol";
import { LogApp } from "../../../webview-ui/log/LogApp";
import { stubLayout } from "./dom";
import { notify, requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);

const job = {
  id: 7,
  name: "unit",
  status: "running",
  allowFailure: false,
  webUrl: "https://gitlab.com/j/7",
  duration: 5,
};
let init: LogInit;

beforeAll(() => stubLayout());
beforeEach(() => {
  resetMessenger();
  init = { text: "one\ntwo\n", job };
  respond.mockImplementation((method) => (method === "log/getInit" ? init : undefined));
});
afterEach(cleanup);

const lines = (container: HTMLElement) => [...container.querySelectorAll(".log-line")].map((l) => l.textContent);

describe("LogApp", () => {
  test("shows the initial log and appends new chunks once", async () => {
    const { container } = render(<LogApp />);
    await screen.findByText("one");
    notify("log/append", { start: 0, text: "one\n" });
    notify("log/append", { start: 8, text: "three\n" });
    expect(lines(container)).toEqual(["one", "two", "three"]);
    expect(screen.getByText("unit")).toBeTruthy();
  });

  test("collapsed sections hide their lines until expanded", async () => {
    init = { text: "section_start:1:prepare[collapsed=true]\rPrep\nhidden\nsection_end:2:prepare\r\nafter\n" };
    const { container } = render(<LogApp />);
    const header = await screen.findByRole("button", { name: /Prep/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(lines(container)).not.toContain("hidden");
    fireEvent.click(header);
    expect(lines(container)).toContain("hidden");
  });

  test("status and error notifications", async () => {
    render(<LogApp />);
    await screen.findByText("one");
    notify("log/status", { ...job, status: "failed" });
    expect(screen.getByRole("img", { name: "failed" })).toBeTruthy();
    notify("log/error", { message: "404 Job Not Found" });
    expect(screen.getByRole("alert").textContent).toContain("404 Job Not Found");
  });

  test("search jumps to matches", async () => {
    const { container } = render(<LogApp />);
    await screen.findByText("one");
    const search = screen.getByRole("searchbox", { name: "Search log" });
    fireEvent.change(search, { target: { value: "TWO" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("two");
    expect(screen.getByText("1/1")).toBeTruthy();
  });

  test("open in browser", async () => {
    render(<LogApp />);
    await screen.findByText("one");
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(requests("log/openUrl")).toEqual([{ url: "https://gitlab.com/j/7" }]);
  });
});

test("keeps log chunks arriving while the initial snapshot is in flight", async () => {
  let release: (value: LogInit) => void = () => undefined;
  respond.mockImplementation(
    () =>
      new Promise<LogInit>((r) => {
        release = r;
      }),
  );
  const { container } = render(<LogApp />);
  notify("log/append", { start: 8, text: "three\n" });
  await act(async () => release({ text: "one\ntwo\n", job }));
  expect(lines(container)).toEqual(["one", "two", "three"]);
});

test("shows an error from the initial log snapshot", async () => {
  init = { text: "", error: "Job not found" };
  render(<LogApp />);
  expect((await screen.findByRole("alert")).textContent).toContain("Job not found");
});
