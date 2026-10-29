import { expect, test } from "vitest";
import { matchesAnnotations, parseAnnotationFilter } from "../../../src/core/resource/annotationFilter";

test("annotation filter: key, key=value, key!=value (AND), empty = everything", () => {
  const conditions = parseAnnotationFilter(" prometheus.io/scrape=true , sidecar.istio.io/inject!=false, team ");
  expect(conditions).toEqual([
    { key: "prometheus.io/scrape", op: "eq", value: "true" },
    { key: "sidecar.istio.io/inject", op: "neq", value: "false" },
    { key: "team", op: "exists" },
  ]);
  expect(matchesAnnotations({ "prometheus.io/scrape": "true", team: "a" }, conditions)).toBe(true);
  expect(matchesAnnotations({ "prometheus.io/scrape": "true" }, conditions)).toBe(false);
  expect(
    matchesAnnotations({ "prometheus.io/scrape": "true", team: "a", "sidecar.istio.io/inject": "false" }, conditions),
  ).toBe(false);
  expect(matchesAnnotations({}, parseAnnotationFilter(""))).toBe(true);
});
