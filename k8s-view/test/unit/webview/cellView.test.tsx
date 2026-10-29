// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { TableColumn } from "../../../src/shared/protocol";
import { CellView } from "../../../webview-ui/components/CellView";

afterEach(cleanup);
const column: TableColumn = { id: "cpu-used", title: "CPU Used", render: "cpu", hidden: false };

test.each(["ok", "warning", "error"] as const)(
  "metric %s color includes an accessible indicator and explanatory tooltip",
  (level) => {
    render(
      <CellView
        column={column}
        cell={{ text: "800m", sort: 0.8, level, tooltip: "CPU usage: 80% of request." }}
        now={0}
      />,
    );
    const icon = screen.getByRole("img", { name: "CPU usage: 80% of request." });
    expect(icon.className).toContain(`level-${level}`);
    expect(screen.getByText("800m").parentElement?.className).toContain(`cell-metric level-${level}`);
    expect(screen.getByTitle("CPU usage: 80% of request.")).toBeTruthy();
  },
);

test("missing budget shows its dash with a warning; missing usage remains neutral", () => {
  const { rerender } = render(
    <CellView
      column={{ ...column, render: "memory" }}
      cell={{ text: "-", sort: null, level: "warning", tooltip: "Missing Memory limit: app." }}
      now={0}
    />,
  );
  expect(screen.getByText("-").parentElement?.className).toContain("level-warning");
  rerender(<CellView column={column} cell={{ text: "-", sort: null }} now={0} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("-").className).toBe("cell-text");
});
