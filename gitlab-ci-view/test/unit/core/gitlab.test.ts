import { describe, expect, test } from "vitest";
import { jobActions, pipelineActions } from "../../../src/core/gitlab/actions";
import { pipelineEvent } from "../../../src/core/gitlab/filterOptions";
import { jobSchema, pipelineSchema } from "../../../src/core/gitlab/model";
import { groupByStage, stageStatus } from "../../../src/core/gitlab/stages";
import { isActive, statusIcon, statusLabel, statusLevel } from "../../../src/core/gitlab/status";

describe("schemas", () => {
  test("pipeline JSON maps to camelCase and tolerates missing optional fields", () => {
    const p = pipelineSchema.parse({
      id: 10,
      iid: 3,
      project_id: 7,
      status: "running",
      ref: "main",
      sha: "abc",
      web_url: "https://gitlab.com/g/p/-/pipelines/10",
      created_at: "2026-10-29T10:00:00Z",
    });
    expect(p).toEqual({
      id: 10,
      iid: 3,
      projectId: 7,
      status: "running",
      source: undefined,
      ref: "main",
      sha: "abc",
      webUrl: "https://gitlab.com/g/p/-/pipelines/10",
      createdAt: "2026-10-29T10:00:00Z",
      updatedAt: undefined,
    });
  });

  test("job JSON defaults allow_failure and nullable times", () => {
    const j = jobSchema.parse({
      id: 5,
      name: "unit",
      stage: "test",
      status: "failed",
      duration: null,
      web_url: "u",
      created_at: "t",
      started_at: null,
      pipeline: { id: 10 },
    });
    expect(j).toMatchObject({ allowFailure: false, duration: undefined, startedAt: undefined, pipelineId: 10 });
  });
});

describe("status", () => {
  test("active states", () => {
    for (const s of ["created", "waiting_for_resource", "preparing", "pending", "running", "canceling"])
      expect(isActive(s), s).toBe(true);
    for (const s of ["success", "failed", "canceled", "skipped", "manual", "scheduled"])
      expect(isActive(s), s).toBe(false);
  });

  test("levels and icons honour allow_failure", () => {
    expect(statusLevel("failed")).toBe("error");
    expect(statusLevel("failed", true)).toBe("warning");
    expect(statusIcon("failed", true)).toBe("warning");
    expect(statusIcon("running")).toBe("sync~spin");
    expect(statusLevel("manual")).toBe("manual");
    expect(statusLevel("brand_new_status")).toBe("neutral");
    expect(statusLabel("waiting_for_resource")).toBe("waiting for resource");
  });
});

describe("actions", () => {
  test("pipeline actions", () => {
    expect(pipelineActions("failed")).toEqual(["retry"]);
    expect(pipelineActions("canceled")).toEqual(["retry"]);
    expect(pipelineActions("running")).toEqual(["cancel"]);
    expect(pipelineActions("canceling")).toEqual([]);
    expect(pipelineActions("success")).toEqual([]);
  });

  test("job actions", () => {
    expect(jobActions("manual")).toEqual(["play"]);
    expect(jobActions("running")).toEqual(["cancel"]);
    expect(jobActions("success")).toEqual(["retry"]);
    expect(jobActions("failed")).toEqual(["retry"]);
    expect(jobActions("skipped")).toEqual([]);
    expect(jobActions("canceling")).toEqual([]);
  });
});

describe("stages", () => {
  test("groups by stage in order of the first job id", () => {
    const jobs = [
      { id: 9, stage: "deploy" },
      { id: 2, stage: "test" },
      { id: 1, stage: "build" },
      { id: 3, stage: "test" },
    ];
    expect(groupByStage(jobs).map((g) => [g.stage, g.jobs.map((j) => j.id)])).toEqual([
      ["build", [1]],
      ["test", [2, 3]],
      ["deploy", [9]],
    ]);
  });

  test("stage status: failed beats running beats manual beats success", () => {
    const j = (status: string, allowFailure = false) => ({ status, allowFailure });
    expect(stageStatus([j("success"), j("failed")])).toBe("failed");
    expect(stageStatus([j("success"), j("failed", true)])).toBe("success");
    expect(stageStatus([j("running"), j("success")])).toBe("running");
    expect(stageStatus([j("manual"), j("success")])).toBe("manual");
    expect(stageStatus([j("skipped"), j("success")])).toBe("success");
    expect(stageStatus([j("skipped")])).toBe("skipped");
  });
});

test("event labels distinguish tag pushes, branch pushes and merge requests", () => {
  expect(pipelineEvent({ source: "push", tag: true })).toBe("Push · Tag");
  expect(pipelineEvent({ source: "push", tag: false })).toBe("Push · Branch");
  expect(pipelineEvent({ source: "merge_request_event", tag: false })).toBe("Merge request");
  expect(pipelineEvent({ source: "web", tag: true })).toBe("Run manually · Tag");
  expect(pipelineEvent({ source: "push" })).toBe("Push");
  expect(pipelineEvent({ source: undefined })).toBe("Unknown event");
});
