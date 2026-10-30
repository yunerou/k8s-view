import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileAwsConfigSource } from "../../../src/infra/aws/FileAwsConfigSource";

describe("FileAwsConfigSource", () => {
  test("reads ~/.aws/config and ~/.aws/credentials; missing files are empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "aws-view-home-"));
    await mkdir(join(home, ".aws"));
    await writeFile(join(home, ".aws", "config"), "[default]\nregion = eu-west-1\n");
    const files = await new FileAwsConfigSource({}, home).read();
    expect(files).toEqual({ config: { default: { region: "eu-west-1" } }, credentials: {} });
  });

  test("AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE take precedence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aws-view-env-"));
    await writeFile(join(dir, "c"), "[profile x]\nregion = us-east-1\n");
    await writeFile(join(dir, "k"), "[x]\naws_access_key_id = A\n");
    const files = await new FileAwsConfigSource(
      { AWS_CONFIG_FILE: join(dir, "c"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "k") },
      "/nonexistent",
    ).read();
    expect(files.config).toEqual({ "profile x": { region: "us-east-1" } });
    expect(files.credentials).toEqual({ x: { aws_access_key_id: "A" } });
  });
});
