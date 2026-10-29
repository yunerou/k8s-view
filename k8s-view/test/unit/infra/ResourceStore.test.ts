import { expect, test } from "vitest";
import { ResourceStore } from "../../../src/infra/kube/ResourceStore";
import { kinds } from "../helpers/fixtures";

test("replace() drops items from the cached snapshot (relist returning nothing)", () => {
  const store = new ResourceStore(kinds.job);
  store.replace([{ metadata: { name: "j", uid: "j1", resourceVersion: "1" } }]);
  expect(store.items()).toHaveLength(1);
  store.replace([]);
  expect(store.items()).toEqual([]);
});
