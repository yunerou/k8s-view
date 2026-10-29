import { expect, test } from "vitest";
import { pathToRef, refToPath } from "../../../src/ui/ResourceRefs";

test("ref ↔ path round trip with core group, cluster scope and special characters", () => {
  const refs = [
    { context: "arn:aws:eks:ap/cluster", group: "", kind: "Pod", namespace: "a", name: "web-1" },
    {
      context: "kind",
      group: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      namespace: undefined,
      name: "system:view",
    },
  ];
  for (const r of refs) expect(pathToRef(refToPath(r, ".yaml"), ".yaml")).toEqual(r);
  expect(refToPath(refs[0]!, ".yaml")).toBe("/arn%3Aaws%3Aeks%3Aap%2Fcluster/_core/Pod/a/web-1.yaml");
});
