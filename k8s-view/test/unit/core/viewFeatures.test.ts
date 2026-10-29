import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileCommand } from "../../../src/core/command/CommandDefinition";
import { renderRun } from "../../../src/core/command/CommandTemplate";
import { parseConfigText } from "../../../src/core/config/parseConfig";
import { CommandSchema, type ViewConfig, ViewSchema } from "../../../src/core/config/schema";
import { ExpressionEngine } from "../../../src/core/expression/ExpressionEngine";
import { ResourceKind } from "../../../src/core/resource/ResourceKind";
import { KIND_VIEW_ID, kindViewConfig } from "../../../src/core/view/kindView";
import { CompiledRelation } from "../../../src/core/view/RelationResolver";
import { compileView, type SectionDefinition } from "../../../src/core/view/ViewDefinition";
import { kinds, res } from "../helpers/fixtures";

const engine = new ExpressionEngine("safe");
const resources = join(__dirname, "../../../resources");

function builtinView(file: string): ReturnType<typeof compileView>["view"] {
  const parsed = parseConfigText(readFileSync(join(resources, file), "utf8"));
  return compileView(parsed.views[0]!.config as ViewConfig, engine).view;
}
const section = (view: ReturnType<typeof builtinView>, id: string): SectionDefinition =>
  view.sections.find((s) => s.id === id)!;

const node = new ResourceKind("", "v1", "Node", "nodes", false);
const event = new ResourceKind("", "v1", "Event", "events", true);
const pvc = new ResourceKind("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims", true);
const pv = new ResourceKind("", "v1", "PersistentVolume", "persistentvolumes", false);
const storageClass = new ResourceKind("storage.k8s.io", "v1", "StorageClass", "storageclasses", false);

describe("status rules with icon, color and summary", () => {
  test("rule fields are returned with the level", () => {
    const { view } = compileView(
      ViewSchema.parse({
        id: "v",
        title: "V",
        sections: [
          {
            id: "pods",
            title: "Pods",
            resources: [{ kind: "Pod" }],
            label: "${$.metadata.labels.app}",
            status: {
              rules: [
                {
                  when: { path: "$.status.phase", op: "eq", value: "Succeeded" },
                  level: "ok",
                  summary: "Completed",
                  icon: "circle-filled",
                  color: "disabledForeground",
                },
              ],
              default: "unknown",
            },
          },
        ],
      }),
      engine,
    );
    const pods = view.sections[0]!;
    const done = res(kinds.pod, "job-1", {
      metadata: { name: "job-1", uid: "job-1", labels: { app: "batch" } },
      status: { phase: "Succeeded" },
    });
    expect(pods.status(done)).toEqual({
      level: "ok",
      summary: "Completed",
      icon: "circle-filled",
      color: "disabledForeground",
    });
    expect(pods.label(done)).toBe("batch");
    // Empty label → resource name.
    expect(pods.label(res(kinds.pod, "plain"))).toBe("plain");
  });

  test("Workload includes CronJobs and standalone Jobs with outlined status icons", () => {
    const workload = builtinView("views/workload.json");
    expect(workload.sections.some((s) => s.id === "jobs")).toBe(true);
    const cronjobs = section(workload, "cronjobs");
    const jobs = cronjobs.children[0]!;
    const pods = jobs.children[0]!;
    for (const [phase, color, level] of [
      ["Succeeded", "charts.blue", "ok"],
      ["Running", "charts.green", "ok"],
      ["Failed", "charts.red", "error"],
      ["Pending", "charts.yellow", "warning"],
      ["Unknown", "charts.yellow", "warning"],
    ]) {
      expect(pods.status(res(kinds.pod, "p", { status: { phase } }))).toMatchObject({
        icon: "circle-outline",
        color,
        level,
      });
    }
    expect(
      jobs.status(res(kinds.job, "j", { status: { conditions: [{ type: "Complete", status: "True" }] } })),
    ).toMatchObject({ icon: "circle-outline", color: "charts.blue" });
    expect(jobs.status(res(kinds.job, "j", { status: { active: 1 } }))).toMatchObject({ color: "charts.green" });
    expect(
      jobs.status(res(kinds.job, "j", { status: { conditions: [{ type: "Failed", status: "True" }] } })),
    ).toMatchObject({ color: "charts.red" });
    expect(jobs.status(res(kinds.job, "j"))).toMatchObject({ color: "charts.yellow" });
  });
});

describe("built-in views", () => {
  test("Event: label is the involved object, sorted by last seen (lastTimestamp or eventTime), newest first", () => {
    const view = builtinView("views/event.json");
    const all = section(view, "events");
    const e = (name: string, extra: object) =>
      res(event, name, { involvedObject: { kind: "Pod", name: "web-1" }, type: "Normal", reason: "Pulled", ...extra });
    const old = e("a", { lastTimestamp: "2026-10-20T00:00:00Z" });
    const recent = e("b", { lastTimestamp: null, eventTime: "2026-10-22T00:00:00.123456Z" });
    expect(all.label(old)).toBe("Pod/web-1");
    const lastSeen = all.columns.find((c) => c.id === "last-seen")!;
    const now = Date.parse("2026-10-23T00:00:00Z");
    expect(lastSeen.evaluate(recent, now).timestamp).toBe(Date.parse("2026-10-22T00:00:00.123Z"));
    expect(lastSeen.evaluate(old, now).timestamp).toBe(Date.parse("2026-10-20T00:00:00Z"));
    expect(all.sort).toEqual({ by: "last-seen", order: "desc" });
    expect(all.status(e("w", { type: "Warning" }))).toMatchObject({ level: "warning", icon: "warning" });
    const cluster = section(view, "cluster-objects");
    expect(cluster.allNamespaces).toBe(true);
    expect(cluster.accepts(e("n", { involvedObject: { kind: "Node", name: "n1" } }))).toBe(true);
    expect(cluster.accepts(e("p", { involvedObject: { kind: "Pod", name: "x", namespace: "app" } }))).toBe(false);
  });

  test("Node: NotReady, cordoned and pressure states", () => {
    const nodes = section(builtinView("views/node.json"), "nodes");
    const n = (spec: object, conditions: object[]) => res(node, "n1", { spec, status: { conditions } });
    const ready = { type: "Ready", status: "True" };
    expect(nodes.status(n({}, [ready])).level).toBe("ok");
    expect(nodes.status(n({}, [{ type: "Ready", status: "Unknown" }]))).toMatchObject({
      level: "error",
      summary: "NotReady",
    });
    expect(nodes.status(n({ unschedulable: true }, [ready]))).toMatchObject({ summary: "SchedulingDisabled" });
    expect(nodes.status(n({}, [ready, { type: "DiskPressure", status: "True" }]))).toMatchObject({
      summary: "Pressure",
    });
  });

  test("Node: pods are found through spec.nodeName (string reference)", () => {
    const relation = new CompiledRelation(
      {
        type: "reverseFieldRef",
        group: "",
        kind: "Pod",
        items: "$.spec.nodeName",
        match: { name: "${name}" },
        allNamespaces: true,
      },
      engine,
    );
    const on = res(kinds.pod, "a", { spec: { nodeName: "n1" } }, "x");
    const elsewhere = res(kinds.pod, "b", { spec: { nodeName: "n2" } }, "y");
    const lookup = { list: () => [on, elsewhere], byOwner: () => [] };
    const resolution = relation.resolve(res(node, "n1"), lookup);
    expect(resolution.items.map((i) => (i.type === "resource" ? i.resource.name : i.type))).toEqual(["a"]);
    expect(resolution.demands).toEqual([{ group: "", kind: "Pod", namespace: undefined }]);
  });

  test("Service view shows port-forwards; Gateway API view needs the Gateway API group", () => {
    expect(builtinView("views/service.json").portForwards).toBe(true);
    expect(builtinView("views/gateway-api.json").requires).toEqual(["gateway.networking.k8s.io"]);
  });

  test("Volume: PVC and PV phases", () => {
    const view = builtinView("views/volume.json");
    const pvcs = section(view, "pvcs");
    const pvs = section(view, "pvs");
    const claim = (status: object, metadata: object = {}) =>
      res(pvc, "data", { metadata: { name: "data", uid: "pvc-data", ...metadata }, status }, "app");
    expect(pvcs.status(claim({ phase: "Bound" })).level).toBe("ok");
    expect(pvcs.status(claim({ phase: "Pending" }))).toMatchObject({ level: "progress", summary: "Pending" });
    expect(pvcs.status(claim({ phase: "Lost" }))).toMatchObject({ level: "error", summary: "Lost" });
    expect(
      pvcs.status(claim({ phase: "Bound", conditions: [{ type: "FileSystemResizePending", status: "True" }] })),
    ).toMatchObject({ summary: "Resizing" });
    expect(pvcs.status(claim({ phase: "Bound" }, { deletionTimestamp: "2026-10-22T00:00:00Z" }))).toMatchObject({
      summary: "Terminating",
    });
    expect(pvs.status(res(pv, "pv-1", { status: { phase: "Available" } })).level).toBe("ok");
    expect(pvs.status(res(pv, "pv-1", { status: { phase: "Released" } }))).toMatchObject({ level: "warning" });
    expect(pvs.status(res(pv, "pv-1", { status: { phase: "Failed" } }))).toMatchObject({ level: "error" });
  });

  test("Volume: PVC → PV, StorageClass and the pods mounting it", () => {
    const pvcs = section(builtinView("views/volume.json"), "pvcs");
    const child = (id: string) => pvcs.children.find((c) => c.id === id)!.relation;
    const parent = res(pvc, "data", { spec: { volumeName: "pv-1", storageClassName: "gp3" } }, "app");
    const volume = res(pv, "pv-1");
    const gp3 = res(storageClass, "gp3");
    const mounting = res(
      kinds.pod,
      "web",
      { spec: { volumes: [{ persistentVolumeClaim: { claimName: "data" } }] } },
      "app",
    );
    const other = res(
      kinds.pod,
      "db",
      { spec: { volumes: [{ persistentVolumeClaim: { claimName: "logs" } }] } },
      "app",
    );
    const lookup = {
      list: (_g: string, kind: string) =>
        ({ PersistentVolume: [volume], StorageClass: [gp3], Pod: [mounting, other] })[kind],
      byOwner: () => [],
    };
    const names = (id: string) =>
      child(id)
        .resolve(parent, lookup)
        .items.map((i) => (i.type === "resource" ? i.resource.name : i.type));
    expect(names("volume")).toEqual(["pv-1"]);
    expect(names("storageclass")).toEqual(["gp3"]);
    expect(names("pods")).toEqual(["web"]);
  });

  test("Volume: StorageClass → PVCs of every namespace; PV → its claim", () => {
    const view = builtinView("views/volume.json");
    const classes = section(view, "storageclasses");
    const toPvcs = classes.children.find((c) => c.id === "pvcs")!.relation;
    const a = res(pvc, "a", { spec: { storageClassName: "gp3" } }, "x");
    const b = res(pvc, "b", { spec: { storageClassName: "standard" } }, "y");
    const lookup = { list: () => [a, b], byOwner: () => [] };
    const resolution = toPvcs.resolve(res(storageClass, "gp3"), lookup);
    expect(resolution.items.map((i) => (i.type === "resource" ? i.resource.name : i.type))).toEqual(["a"]);
    expect(resolution.demands).toEqual([{ group: "", kind: "PersistentVolumeClaim", namespace: undefined }]);

    const toClaim = section(view, "pvs").children.find((c) => c.id === "claim")!.relation;
    const bound = res(pv, "pv-1", {
      spec: { claimRef: { apiVersion: "v1", kind: "PersistentVolumeClaim", name: "a", namespace: "x" } },
    });
    const claim = toClaim.resolve(bound, { list: () => [a], byOwner: () => [] });
    expect(claim.items.map((i) => (i.type === "resource" ? i.resource.name : i.type))).toEqual(["a"]);
    expect(claim.demands).toEqual([{ group: "", kind: "PersistentVolumeClaim", namespace: "x" }]);
  });
});

test("kind view: one section listing the chosen kind", () => {
  const { view, issues } = compileView(
    kindViewConfig({ group: "cert-manager.io", kind: "Certificate", plural: "certificates" }),
    engine,
  );
  expect(issues).toEqual([]);
  expect(view.id).toBe(KIND_VIEW_ID);
  expect(view.title).toBe("Kind: Certificate");
  expect(view.sections.map((s) => [s.title, s.resources])).toEqual([
    ["certificates.cert-manager.io", [{ group: "cert-manager.io", kind: "Certificate" }]],
  ]);
});

test("${namespaceFlag}: --namespace=<ns>, or --all-namespaces for All namespaces", () => {
  const { command } = compileCommand(
    CommandSchema.parse({
      id: "s",
      title: "S",
      target: "namespace",
      run: { type: "terminal", command: "kubectl", args: ["get", "pods", "${namespaceFlag}"] },
    }),
    "builtin",
    engine,
  );
  const vars = {
    context: "dev",
    cluster: "dev",
    user: "u",
    kubeconfig: "",
    timestamp: "",
    workspaceFolder: undefined,
    inputs: {},
  };
  expect(renderRun(command!, undefined, { ...vars, namespace: "team-a" })).toMatchObject({
    args: ["get", "pods", "--namespace=team-a"],
  });
  expect(renderRun(command!, undefined, { ...vars, namespace: undefined })).toMatchObject({
    args: ["get", "pods", "--all-namespaces"],
  });
});
