import { describe, expect, test } from "vitest";
import { type DagJobInput, layoutDag } from "../../../src/core/dag/layout";

const j = (name: string, needs: string[] = [], extra: Partial<DagJobInput> = {}): DagJobInput => ({
  id: undefined,
  name,
  status: "success",
  needs,
  ...extra,
});

describe("layoutDag", () => {
  test("columns per stage, rows per job, edges per need", () => {
    const layout = layoutDag([
      { name: "build", jobs: [j("compile"), j("lint")] },
      { name: "test", jobs: [j("unit", ["compile"]), j("e2e")] },
      { name: "deploy", jobs: [j("prod", ["unit", "e2e"])] },
    ]);
    expect(layout.columns).toEqual([
      { stage: "build", x: 12 },
      { stage: "test", x: 256 },
      { stage: "deploy", x: 500 },
    ]);
    expect(layout.nodes.map((n) => [n.key, n.x, n.y])).toEqual([
      ["compile", 12, 40],
      ["lint", 12, 80],
      ["unit", 256, 40],
      ["e2e", 256, 80],
      ["prod", 500, 40],
    ]);
    expect(layout.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["compile->unit", "unit->prod", "e2e->prod"]);
    expect(layout.edges[0]?.path).toBe("M192 55 C224 55 224 55 256 55");
    expect([layout.width, layout.height]).toEqual([692, 122]);
  });

  test("a need on a parallel job group links every instance", () => {
    const layout = layoutDag([
      { name: "test", jobs: [j("rspec 1/2", [], { group: "rspec" }), j("rspec 2/2", [], { group: "rspec" })] },
      { name: "deploy", jobs: [j("prod", ["rspec", "rspec"])] },
    ]);
    expect(layout.edges.map((e) => e.from)).toEqual(["rspec 1/2", "rspec 2/2"]);
  });

  test("ignores unknown needs and empty stages", () => {
    const layout = layoutDag([
      { name: "empty", jobs: [] },
      { name: "deploy", jobs: [j("prod", ["optional-job-not-in-pipeline"])] },
    ]);
    expect(layout.columns).toEqual([{ stage: "deploy", x: 12 }]);
    expect(layout.edges).toEqual([]);
  });

  test("an empty pipeline has an empty layout", () => {
    expect(layoutDag([])).toMatchObject({ nodes: [], edges: [], columns: [] });
  });
});
