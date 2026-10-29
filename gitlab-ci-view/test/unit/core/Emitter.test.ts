import { describe, expect, test, vi } from "vitest";
import { Emitter } from "../../../src/core/util/Emitter";

describe("Emitter", () => {
  test("delivers events until the listener is disposed", () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const sub = emitter.event((n) => seen.push(n));
    emitter.fire(1);
    sub.dispose();
    emitter.fire(2);
    expect(seen).toEqual([1]);
  });

  test("a throwing listener does not stop the others", () => {
    const emitter = new Emitter<void>();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = vi.fn();
    emitter.event(() => {
      throw new Error("boom");
    });
    emitter.event(second);
    emitter.fire();
    expect(second).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
