import { expect, test } from "vitest";
import { resourceDocumentation } from "../../../src/core/resource/resourceDocumentation";

test("documentation uses both API group and kind without guessing custom-resource URLs", () => {
  expect(resourceDocumentation({ group: "", kind: "Pod" })).toBe("https://kubernetes.io/docs/concepts/workloads/pods/");
  expect(resourceDocumentation({ group: "example.com", kind: "Pod" })).toBeUndefined();
  expect(resourceDocumentation({ group: "example.com", kind: "Widget" })).toBeUndefined();
  expect(resourceDocumentation({ group: "apps", kind: "Unknown" })).toBeUndefined();
});
