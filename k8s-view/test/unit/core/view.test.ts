import { describe, expect, test } from "vitest";
import { ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { applyCommandPatch, applyViewPatch, slug } from "../../../src/core/view/merge";
import { compileView } from "../../../src/core/view/ViewDefinition";
import { kinds, res } from "../helpers/fixtures";

const engine = new ExpressionEngine("safe");
const now = Date.parse("2026-10-22T00:00:00Z");

const workload = ViewSchema.parse({
  id: "workload",
  title: "Workload",
  sections: [
    {
      id: "deployments",
      title: "Deployments",
      resources: [{ group: "apps", kind: "Deployment" }],
      status: { preset: "replicas" },
      columns: [
        { title: "Ready", template: "${$.status.readyReplicas}/${$.spec.replicas}" },
        { title: "Images", path: "$.spec.template.spec.containers[*].image" },
        { title: "Age", path: "$.metadata.creationTimestamp", render: "age" },
        { title: "Paused", path: "$.spec.paused", render: "boolean", default: "-" },
        { title: "Labels", path: "$.metadata.labels", render: "labels" },
        { title: "Containers", path: "$.spec.template.spec.containers", render: "count" },
        { title: "Phase", path: "$.status.phase", render: "status" },
      ],
      children: [
        {
          relation: { type: "ownerRef", group: "apps", kind: "ReplicaSet" },
          children: [{ relation: { type: "ownerRef", kind: "Pod" } }],
        },
      ],
    },
    {
      id: "pods",
      title: "Pods",
      resources: [{ kind: "Pod" }],
      description: "${$.status.phase}",
      groupBy: "label:app",
      sort: { by: "age", order: "desc" },
    },
  ],
});

describe("compileView", () => {
  const { view, issues } = compileView(workload, engine);
  const deploy = res(kinds.deployment, "web", {
    metadata: { name: "web", uid: "d1", labels: { app: "web", tier: "fe" }, creationTimestamp: "2026-10-20T00:00:00Z" },
    spec: { replicas: 3, template: { spec: { containers: [{ image: "nginx:1" }, { image: "envoy:2" }] } } },
    status: { readyReplicas: 2, phase: "Running" },
  });

  test("compiles without issues", () => {
    expect(issues).toEqual([]);
    expect(view!.sections.map((s) => s.id)).toEqual(["deployments", "pods"]);
  });

  test("column ids default to slug(title)", () => {
    expect(view!.sections[0]!.columns.map((c) => c.id)).toEqual([
      "ready",
      "images",
      "age",
      "paused",
      "labels",
      "containers",
      "phase",
    ]);
  });

  test("evaluates cells per render kind", () => {
    const cells = view!.sections[0]!.columns.map((c) => c.evaluate(deploy, now));
    expect(cells[0]).toMatchObject({ text: "2/3" });
    expect(cells[1]).toMatchObject({ text: "nginx:1, envoy:2" });
    expect(cells[2]).toMatchObject({ text: "2d", timestamp: Date.parse("2026-10-20T00:00:00Z") });
    expect(cells[3]).toMatchObject({ text: "-" });
    expect(cells[4]).toMatchObject({ text: "app=web, tier=fe", badges: ["app=web", "tier=fe"] });
    expect(cells[5]).toMatchObject({ text: "2", sort: 2 });
    expect(cells[6]).toMatchObject({ text: "Running", level: "ok" });
  });

  test("status, description defaults, groupBy and child ids", () => {
    const section = view!.sections[0]!;
    expect(section.status(deploy)).toEqual({ level: "warning", summary: "2/3" });
    expect(section.describe(deploy, now)).toBe("2/3 · 2d");
    expect(section.children[0]!.id).toBe("ownerRef:apps/ReplicaSet");
    expect(section.children[0]!.children[0]!.id).toBe("ownerRef:/Pod");
    const pods = view!.sections[1]!;
    const pod = res(kinds.pod, "p", {
      metadata: { name: "p", uid: "p", labels: { app: "web" } },
      status: { phase: "Pending" },
    });
    expect(pods.describe(pod, now)).toBe("Pending");
    expect(pods.groupKey(pod)).toBe("web");
    expect(pods.sort).toEqual({ by: "age", order: "desc" });
  });

  test("reports expression errors with their config path and keeps the rest", () => {
    const strict = new ExpressionEngine(false);
    const cfg = ViewSchema.parse({
      id: "v",
      title: "V",
      sections: [
        {
          id: "s",
          title: "S",
          resources: [{ kind: "Pod" }],
          columns: [
            { title: "Ok", path: "$.a" },
            { title: "Bad", path: "$.c[?(@.type=='Ready')].status" },
          ],
        },
      ],
    });
    const r = compileView(cfg, strict);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.path).toEqual(["sections", 0, "columns", 1, "path"]);
    expect(r.view!.sections[0]!.columns.map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("applyViewPatch", () => {
  test("deep merges by id, removes items, appends new ones", () => {
    const merged = applyViewPatch(workload, {
      extends: "workload",
      title: "My Workload",
      sections: [
        { id: "pods", remove: true },
        {
          id: "deployments",
          columns: [
            { title: "Images", hidden: true },
            { id: "age", remove: true },
            { title: "Strategy", path: "$.spec.strategy.type" },
          ],
        },
        { id: "jobs", title: "Jobs", resources: [{ group: "batch", kind: "Job" }] },
      ],
    });
    const v = ViewSchema.parse(merged);
    expect(v.id).toBe("workload");
    expect(v.title).toBe("My Workload");
    expect(v.sections.map((s) => s.id)).toEqual(["deployments", "jobs"]);
    const cols = v.sections[0]!.columns;
    expect(cols.map((c) => c.title)).toEqual([
      "Ready",
      "Images",
      "Paused",
      "Labels",
      "Containers",
      "Phase",
      "Strategy",
    ]);
    expect(cols[1]!.hidden).toBe(true);
    expect(v.sections[0]!.status).toEqual({ preset: "replicas" });
  });

  test("replaces filter/status/resources instead of merging them", () => {
    const merged = applyViewPatch(workload, {
      extends: "workload",
      sections: [
        {
          id: "deployments",
          status: { rules: [{ when: { op: "exists", path: "$.a" }, level: "ok" }], default: "unknown" },
        },
      ],
    }) as { sections: { status: unknown }[] };
    expect(merged.sections[0]!.status).toEqual({
      rules: [{ when: { op: "exists", path: "$.a" }, level: "ok" }],
      default: "unknown",
    });
  });

  test("patch id creates a copy under a new id", () => {
    expect((applyViewPatch(workload, { extends: "workload", id: "workload-2" }) as { id: string }).id).toBe(
      "workload-2",
    );
  });
});

describe("applyCommandPatch", () => {
  test("overrides fields shallowly and keeps id", () => {
    const base = { id: "pod.delete", title: "Delete", dangerous: true, run: { type: "kubectl", args: ["delete"] } };
    expect(applyCommandPatch(base, { extends: "pod.delete", dangerous: false })).toEqual({ ...base, dangerous: false });
  });
});

test("slug", () => {
  expect(slug("Up-to-date (pods)")).toBe("up-to-date-pods");
  expect(slug("  ")).toBe("column");
});
