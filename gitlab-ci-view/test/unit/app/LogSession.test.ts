import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LogSession } from "../../../src/app/LogSession";
import { PipelineService } from "../../../src/app/PipelineService";
import { GitLabError } from "../../../src/app/ports/GitLabApi";
import { type FakeCall, FakeGitLabApi, rawJob, repoRef } from "../helpers/gitlab";

const P = "/projects/team%2Fweb";
const full = Buffer.from("line1\nliné2\n", "utf8");
let api: FakeGitLabApi;
let statuses: string[];
let session: LogSession;

beforeEach(() => {
  vi.useFakeTimers();
  statuses = ["running", "running", "success"];
  api = new FakeGitLabApi()
    .route(`GET ${P}/jobs/7`, () => rawJob({ id: 7, status: statuses.shift() ?? "success" }))
    // First response returns 10 bytes: splits the two bytes of "é".
    .route(`BYTES ${P}/jobs/7/trace`, (c: FakeCall) =>
      full.subarray(c.offset ?? 0, (c.offset ?? 0) === 0 ? 10 : undefined),
    );
  session = new LogSession(api, new PipelineService(api), repoRef(), 7, 1000);
});

afterEach(() => {
  session.dispose();
  vi.useRealTimers();
});

describe("LogSession", () => {
  test("reads the trace incrementally without breaking multi-byte characters, then stops", async () => {
    const chunks: { start: number; text: string }[] = [];
    session.onAppend((c) => chunks.push(c));
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks.map((c) => c.text).join("")).toBe("line1\nliné2\n");
    expect(session.content).toBe("line1\nliné2\n");
    expect(chunks[1]?.start).toBe(chunks[0]?.text.length);
    expect(api.callsTo("BYTES", `${P}/jobs/7/trace`).map((c) => c.offset)).toEqual([0, 10, 13]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.callsTo("GET", `${P}/jobs/7`)).toHaveLength(3);
  });

  test("status events fire only when the status changes", async () => {
    const seen: string[] = [];
    session.onStatus((j) => seen.push(j.status));
    await session.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["running", "success"]);
    expect(session.job?.status).toBe("success");
  });

  test("a missing job stops polling; a network error retries", async () => {
    const errors: string[] = [];
    session.onError((m) => errors.push(m));
    api.route(`GET ${P}/jobs/7`, new GitLabError("network", "socket hang up", "gitlab.com"));
    await session.start();
    api.route(`GET ${P}/jobs/7`, new GitLabError("notFound", "404 Job Not Found", "gitlab.com", 404));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors).toEqual(["socket hang up", "404 Job Not Found"]);
    expect(api.callsTo("GET", `${P}/jobs/7`)).toHaveLength(2);
  });

  test("dispose stops polling", async () => {
    await session.start();
    session.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.callsTo("GET", `${P}/jobs/7`)).toHaveLength(1);
  });
});

test("pauses log polling while hidden and resumes once visible", async () => {
  await session.start();
  session.setPaused(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.callsTo("GET", `${P}/jobs/7`)).toHaveLength(1);
  session.setPaused(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.callsTo("GET", `${P}/jobs/7`)).toHaveLength(2);
});

test("retains the error for a webview that connects after a fatal failure", async () => {
  api.route(`GET ${P}/jobs/7`, new GitLabError("notFound", "Job not found", "gitlab.com", 404));
  await session.start();
  expect(session.error).toBe("Job not found");
});
