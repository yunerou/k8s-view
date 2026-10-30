// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TagEditorInit } from "../../../src/shared/protocol";
import { TagApp } from "../../../webview-ui/tags/TagApp";
import { requests, resetMessenger, respond } from "./messengerMock";

vi.mock("../../../webview-ui/shared/messenger", async () => (await import("./messengerMock")).messengerModule);
vi.mock("../../../webview-ui/components/vsc", async () => await import("./vscMock"));

const init: TagEditorInit = {
  instanceId: "i-1",
  label: "box",
  rows: [
    { key: "Name", value: "box" },
    { key: "Owner", value: "me" },
  ],
  readOnlyCount: 1,
};
let saveResult: { error?: string };

beforeEach(() => {
  resetMessenger();
  saveResult = {};
  respond.mockImplementation((method) =>
    method === "tags/getInit" ? init : method === "tags/save" ? saveResult : undefined,
  );
});
afterEach(cleanup);

describe("TagApp", () => {
  test("shows the editable tags plus an empty row, and how many AWS tags are hidden", async () => {
    render(<TagApp />);
    expect(await screen.findByDisplayValue("Owner")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Key \d+$/)).toHaveLength(3);
    expect(screen.getByText("1 tag managed by AWS (aws:…) is hidden and stays unchanged.")).toBeTruthy();
  });

  test("edits, adds and removes rows, then saves them", async () => {
    render(<TagApp />);
    fireEvent.input(await screen.findByDisplayValue("me"), { target: { value: "you" } });
    fireEvent.input(screen.getByLabelText("Key 3"), { target: { value: "Env" } });
    fireEvent.input(screen.getByLabelText("Value 3"), { target: { value: "dev" } });
    fireEvent.click(screen.getByText("Add tag"));
    expect(screen.getAllByLabelText(/^Key \d+$/)).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("Remove tag 1"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(requests("tags/save")).toEqual([
        {
          rows: [
            { key: "Owner", value: "you" },
            { key: "Env", value: "dev" },
            { key: "", value: "" },
          ],
        },
      ]),
    );
  });

  test("validation errors disable Save; a server error is shown", async () => {
    saveResult = { error: "Missing IAM permission: ec2:CreateTags." };
    render(<TagApp />);
    const key = await screen.findByDisplayValue("Owner");
    fireEvent.input(key, { target: { value: "Name" } });
    expect(screen.getByText("Duplicate key")).toBeTruthy();
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(key, { target: { value: "aws:x" } });
    expect(screen.getByText("Keys starting with aws: are reserved")).toBeTruthy();
    fireEvent.input(key, { target: { value: "Owner" } });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("Missing IAM permission: ec2:CreateTags.")).toBeTruthy();
  });

  test("Cancel closes the editor", async () => {
    render(<TagApp />);
    await screen.findByDisplayValue("Owner");
    fireEvent.click(screen.getByText("Cancel"));
    expect(requests("tags/cancel")).toHaveLength(1);
  });
  test("request failures are shown and Save can be retried", async () => {
    respond.mockImplementation((method) => {
      if (method === "tags/getInit") return init;
      if (method === "tags/save") throw new Error("Connection lost");
      return undefined;
    });
    render(<TagApp />);
    await screen.findByDisplayValue("Owner");
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("Connection lost")).toBeTruthy();
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
  });

  test("initialization failures are shown", async () => {
    respond.mockRejectedValue(new Error("Cannot load tags"));
    render(<TagApp />);
    expect(await screen.findByText("Cannot load tags")).toBeTruthy();
  });
});
