import { describe, expect, test } from "vitest";
import { ExpressionEngine, ExpressionError } from "../../../src/core/expression/ExpressionEngine";
import { parseTemplate } from "../../../src/core/expression/Template";

const pod = {
  metadata: { name: "web-1", namespace: "team-a", labels: { app: "web" } },
  spec: { containers: [{ name: "app" }, { name: "sidecar" }], replicas: 3 },
  status: {
    readyReplicas: 2,
    conditions: [
      { type: "Ready", status: "True", message: "ok}" },
      { type: "Stalled", status: "False" },
    ],
  },
};

describe("parseTemplate", () => {
  test("splits literals and expressions", () => {
    expect(parseTemplate("a ${name} b ${$.x}")).toEqual([
      { type: "literal", text: "a " },
      { type: "expr", source: "name", kind: "variable", name: "name", modifiers: [] },
      { type: "literal", text: " b " },
      { type: "expr", source: "$.x", kind: "path", path: "$.x", modifiers: [] },
    ]);
  });

  test("counts braces and quotes inside expressions", () => {
    const parts = parseTemplate("${$.status.conditions[?(@.message=='}')].type}!");
    expect(parts).toEqual([
      {
        type: "expr",
        source: "$.status.conditions[?(@.message=='}')].type",
        kind: "path",
        path: "$.status.conditions[?(@.message=='}')].type",
        modifiers: [],
      },
      { type: "literal", text: "!" },
    ]);
  });

  test("parses prefixed variables and modifiers", () => {
    expect(parseTemplate("${label:app.kubernetes.io/name|upper|trunc:5}")).toEqual([
      {
        type: "expr",
        source: "label:app.kubernetes.io/name|upper|trunc:5",
        kind: "variable",
        name: "label",
        arg: "app.kubernetes.io/name",
        modifiers: [{ name: "upper" }, { name: "trunc", arg: 5 }],
      },
    ]);
  });

  test("reports unterminated expression", () => {
    expect(() => parseTemplate("x ${name")).toThrow(/Unterminated/);
  });
});

describe("ExpressionEngine paths", () => {
  const engine = new ExpressionEngine("safe");

  test("evaluates all matches and first match", () => {
    const p = engine.compilePath("$.spec.containers[*].name");
    expect(p.all(pod)).toEqual(["app", "sidecar"]);
    expect(p.first(pod)).toBe("app");
  });

  test("supports filter expressions in safe mode", () => {
    expect(engine.compilePath("$.status.conditions[?(@.type=='Ready')].status").first(pod)).toBe("True");
  });

  test("returns undefined for missing values", () => {
    expect(engine.compilePath("$.nope.deeper").first(pod)).toBeUndefined();
  });

  test("rejects paths not starting with $", () => {
    expect(() => engine.compilePath("spec.x")).toThrow(ExpressionError);
  });

  test("eval disabled rejects filter expressions at compile time", () => {
    const strict = new ExpressionEngine(false);
    expect(() => strict.compilePath("$.a[?(@.b==1)]")).toThrow(/filter expressions are disabled/);
    expect(strict.compilePath("$.spec.replicas").first(pod)).toBe(3);
  });

  test("safe mode blocks code execution", () => {
    expect(() => engine.compilePath("$..[?(@.constructor.constructor('return process')().exit())]").all(pod)).toThrow();
  });
});

describe("ExpressionEngine templates", () => {
  const engine = new ExpressionEngine("safe");
  const vars: Record<string, string> = { name: "web-1", namespace: "team-a" };
  const ctx = {
    root: pod,
    variable: (name: string, arg?: string) =>
      name === "label" ? (pod.metadata.labels as Record<string, string>)[arg ?? ""] : vars[name],
  };

  test("renders variables, paths and literals", () => {
    const t = engine.compileTemplate("${name}@${namespace}: ${$.status.readyReplicas}/${$.spec.replicas}");
    expect(t.render(ctx)).toBe("web-1@team-a: 2/3");
  });

  test("joins arrays with comma and renders missing as empty", () => {
    expect(engine.compileTemplate("${$.spec.containers[*].name}|${$.x}").render(ctx)).toBe("app,sidecar|");
  });

  test("applies modifiers", () => {
    expect(engine.compileTemplate("${name|upper}-${label:app|trunc:2}-${$.metadata.name|trunc:3}").render(ctx)).toBe(
      "WEB-1-we-web",
    );
  });

  test("value modifiers: count, sum, default", () => {
    const pod2 = {
      spec: { containers: [{ name: "a" }, { name: "b" }] },
      status: {
        containerStatuses: [
          { ready: true, restartCount: 2 },
          { ready: false, restartCount: 3 },
        ],
      },
    };
    const c = { root: pod2, variable: () => undefined };
    expect(
      engine
        .compileTemplate("${$.status.containerStatuses[?(@.ready==true)]|count}/${$.spec.containers|count}")
        .render(c),
    ).toBe("1/2");
    expect(engine.compileTemplate("${$.status.containerStatuses[*].restartCount|sum}").render(c)).toBe("5");
    expect(engine.compileTemplate("${$.status.readyReplicas|default:0}/${$.nope|count}").render(c)).toBe("0/0");
    expect(engine.compileTemplate("${name|default:n/a}").render(c)).toBe("n/a");
  });

  test("validates variable names when an allow-list is given", () => {
    expect(() => engine.compileTemplate("${nme}", { variables: ["name"] })).toThrow(/Unknown variable 'nme'/);
  });

  test("detects whether template is constant", () => {
    expect(engine.compileTemplate("plain").isConstant).toBe(true);
    expect(engine.compileTemplate("${name}").isConstant).toBe(false);
  });
});
