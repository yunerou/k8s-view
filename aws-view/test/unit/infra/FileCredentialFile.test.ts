import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileCredentialFile } from "../../../src/infra/aws/FileCredentialFile";

let dir: string;
let file: FileCredentialFile;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "aws view storage ")), "nested");
  file = new FileCredentialFile(dir);
});

describe("FileCredentialFile", () => {
  test("writes an AWS CLI credentials file readable only by the user", async () => {
    const expiration = new Date("2026-10-30T20:00:00.000Z");
    await file.write("dev-aws-view", { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T", expiration });
    expect(file.path).toBe(join(dir, "credentials"));
    expect(await readFile(file.path, "utf8")).toBe(
      "[dev-aws-view]\naws_access_key_id = A\naws_secret_access_key = S\naws_session_token = T\naws_view_expiration = 2026-10-30T20:00:00.000Z\n",
    );
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect(await file.read("dev-aws-view")).toEqual({
      accessKeyId: "A",
      secretAccessKey: "S",
      sessionToken: "T",
      expiration,
    });
  });

  test("keeps other profiles, removes one, and reads missing profiles as undefined", async () => {
    await file.write("a-aws-view", { accessKeyId: "A", secretAccessKey: "S" });
    await file.write("b-aws-view", { accessKeyId: "B", secretAccessKey: "S" });
    await file.remove("a-aws-view");
    await file.remove("never-written");
    expect(await file.read("a-aws-view")).toBeUndefined();
    expect(await file.read("b-aws-view")).toEqual({ accessKeyId: "B", secretAccessKey: "S" });
    expect(await new FileCredentialFile(join(dir, "empty")).read("x")).toBeUndefined();
  });
  test("does not reuse temporary credentials with a missing or malformed expiration", async () => {
    await mkdir(dir, { recursive: true });
    for (const expiration of ["", "aws_view_expiration = invalid\n"]) {
      await writeFile(
        file.path,
        `[dev-aws-view]\naws_access_key_id = A\naws_secret_access_key = S\naws_session_token = T\n${expiration}`,
      );
      expect(await file.read("dev-aws-view")).toBeUndefined();
    }
  });
});
