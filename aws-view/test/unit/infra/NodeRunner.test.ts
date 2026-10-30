import { describe, expect, test } from "vitest";
import { CanceledError } from "../../../src/core/util/errors";
import { NodeRunner } from "../../../src/infra/process/NodeRunner";

describe("NodeRunner", () => {
  test("returns exit code, stdout, stderr and passes env", async () => {
    const chunks: string[] = [];
    const r = await new NodeRunner().run("/bin/sh", ["-c", 'echo "out $GREETING"; echo err >&2; exit 3'], {
      env: { GREETING: "hi" },
      onOutput: (t) => chunks.push(t),
    });
    expect(r).toEqual({ code: 3, stdout: "out hi\n", stderr: "err\n" });
    expect(chunks.join("")).toContain("out hi");
  });

  test("a missing command gives code null instead of throwing", async () => {
    const r = await new NodeRunner().run("aws-view-command-that-does-not-exist", []);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  test("abort kills the process and rejects with CanceledError", async () => {
    const controller = new AbortController();
    const pending = new NodeRunner().run("/bin/sh", ["-c", "sleep 10"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(CanceledError);
  });
});
