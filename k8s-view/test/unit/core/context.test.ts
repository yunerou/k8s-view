import { describe, expect, test, vi } from "vitest";
import { ClusterContext, isProtectedContext, scopeLabel } from "../../../src/core/context/ClusterContext";
import { Emitter } from "../../../src/core/util/Emitter";

describe("ClusterContext", () => {
  test("withScope returns a new instance", () => {
    const a = new ClusterContext("kind-dev", "kind-dev", "admin", { type: "all" }, false);
    const b = a.withScope({ type: "single", name: "team-a" });
    expect(a.scope).toEqual({ type: "all" });
    expect(b.scope).toEqual({ type: "single", name: "team-a" });
    expect(b.namespace).toBe("team-a");
    expect(a.namespace).toBeUndefined();
    expect(b.equals(a.withScope({ type: "single", name: "team-a" }))).toBe(true);
  });

  test("isProtectedContext matches anchored regexes and ignores invalid ones", () => {
    expect(isProtectedContext("prod-eu", ["prod-.*"])).toBe(true);
    expect(isProtectedContext("my-prod-eu", ["prod-.*"])).toBe(false);
    expect(isProtectedContext("x", ["(", "x"])).toBe(true);
  });

  test("scopeLabel", () => {
    expect(scopeLabel({ type: "all" })).toBe("All namespaces");
    expect(scopeLabel({ type: "single", name: "a" })).toBe("a");
  });
});

describe("Emitter", () => {
  test("fires to listeners until disposed", () => {
    const e = new Emitter<number>();
    const fn = vi.fn();
    const sub = e.event(fn);
    e.fire(1);
    sub.dispose();
    e.fire(2);
    expect(fn.mock.calls).toEqual([[1]]);
  });

  test("a throwing listener does not stop others", () => {
    const e = new Emitter<void>();
    const ok = vi.fn();
    e.event(() => {
      throw new Error("x");
    });
    e.event(ok);
    e.fire();
    expect(ok).toHaveBeenCalled();
  });
});
