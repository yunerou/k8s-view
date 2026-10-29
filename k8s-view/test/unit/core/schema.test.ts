import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  CommandSchema,
  ConfigFileSchema,
  configJsonSchema,
  RelationSchema,
  ViewPatchSchema,
  ViewSchema,
} from "../../../src/core/config/schema";

const fluxView = {
  id: "fluxcd",
  title: "FluxCD",
  icon: "sync",
  requires: ["kustomize.toolkit.fluxcd.io"],
  sections: [
    {
      id: "kustomizations",
      title: "Kustomizations",
      resources: [{ group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" }],
      status: { preset: "readyCondition" },
      description: "${$.status.lastAppliedRevision}",
      columns: [
        { title: "Ready", path: "$.status.conditions[?(@.type=='Ready')].status", render: "status" },
        { title: "Age", path: "$.metadata.creationTimestamp", render: "age" },
      ],
      children: [
        {
          relation: {
            type: "fieldRef",
            items: "$.spec.sourceRef",
            group: { path: "$.apiVersion", default: "source.toolkit.fluxcd.io" },
            kind: { path: "$.kind", default: "GitRepository" },
          },
        },
      ],
    },
  ],
};

describe("ViewSchema", () => {
  test("parses the FluxCD example and applies defaults", () => {
    const v = ViewSchema.parse(fluxView);
    expect(v.enabled).toBe(true);
    const col = v.sections[0]!.columns[0]!;
    expect(col.render).toBe("status");
    expect(col.hidden).toBe(false);
    const rel = v.sections[0]!.children[0]!.relation;
    expect(rel.type === "fieldRef" && rel.name).toBe("$.name");
    expect(rel.type === "fieldRef" && rel.namespace).toBe("$self");
  });

  test("rejects unknown keys (typos)", () => {
    const bad = { ...fluxView, titel: "x" };
    const r = ViewSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  test("column needs exactly one of path or template", () => {
    const section = fluxView.sections[0]!;
    const withBoth = { ...fluxView, sections: [{ ...section, columns: [{ title: "x", path: "$.a", template: "y" }] }] };
    const withNone = { ...fluxView, sections: [{ ...section, columns: [{ title: "x" }] }] };
    expect(ViewSchema.safeParse(withBoth).success).toBe(false);
    expect(ViewSchema.safeParse(withNone).success).toBe(false);
  });

  test("resource group defaults to core", () => {
    const v = ViewSchema.parse({
      id: "pods",
      title: "Pods",
      sections: [{ id: "p", title: "Pods", resources: [{ kind: "Pod" }] }],
    });
    expect(v.sections[0]!.resources[0]!.group).toBe("");
  });

  test("filter requires path except for owner ops", () => {
    const base = { id: "j", title: "J", resources: [{ group: "batch", kind: "Job" }] };
    const ok = ViewSchema.safeParse({
      id: "x",
      title: "X",
      sections: [{ ...base, filter: { op: "notOwnedBy", value: "CronJob" } }],
    });
    expect(ok.success).toBe(true);
    const bad = ViewSchema.safeParse({ id: "x", title: "X", sections: [{ ...base, filter: { op: "eq", value: 1 } }] });
    expect(bad.success).toBe(false);
  });
});

describe("ViewPatchSchema", () => {
  test("accepts partial view with extends and remove markers", () => {
    const p = ViewPatchSchema.parse({
      extends: "workload",
      sections: [
        { id: "pods", remove: true },
        { id: "deployments", columns: [{ title: "Images", hidden: true }] },
      ],
    });
    expect(p.extends).toBe("workload");
  });
});

describe("RelationSchema", () => {
  test("parses every relation type", () => {
    for (const rel of [
      { type: "ownerRef", kind: "Pod" },
      { type: "labelSelector", kind: "Pod", selector: "$.spec.selector" },
      {
        type: "reverseFieldRef",
        group: "rbac.authorization.k8s.io",
        kind: "RoleBinding",
        items: "$.subjects[*]",
        match: { name: "${name}" },
      },
      { type: "field", items: "$.spec.containers[*]", label: "${$.name}" },
    ]) {
      expect(RelationSchema.safeParse(rel).success, JSON.stringify(rel)).toBe(true);
    }
  });
});

describe("CommandSchema", () => {
  test("parses process command with defaults", () => {
    const c = CommandSchema.parse({
      id: "flux.reconcile",
      title: "Flux: Reconcile",
      match: [{ group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" }],
      run: { type: "process", command: "flux", args: ["reconcile", "ks", "${name}"] },
    });
    expect(c.target).toBe("resource");
    expect(c.dangerous).toBe(false);
    expect(c.multi).toBe("none");
  });

  test("rejects unknown run type", () => {
    expect(CommandSchema.safeParse({ id: "x", title: "x", run: { type: "shell", command: "rm" } }).success).toBe(false);
  });
});

describe("ConfigFileSchema", () => {
  test("allows $schema at root only", () => {
    expect(ConfigFileSchema.safeParse({ $schema: "./x.json", version: 1 }).success).toBe(true);
    expect(ConfigFileSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  test("JSON schema allows comments and does not require defaulted fields", () => {
    const schema = configJsonSchema() as z.core.JSONSchema.BaseSchema & { allowComments: boolean };
    expect(schema.allowComments).toBe(true);
    expect(JSON.stringify(schema)).toContain("ownerRef");
    expect(schema.required).toEqual(["version"]);
  });
});
