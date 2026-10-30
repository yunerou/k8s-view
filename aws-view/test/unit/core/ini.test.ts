import { describe, expect, test } from "vitest";
import { parseIni, serializeIni } from "../../../src/core/aws/ini";

describe("parseIni", () => {
  test("reads sections, trims keys and values, skips comments", () => {
    const text = [
      "# comment",
      "[default]",
      "region = eu-west-1  # inline comment",
      "; another comment",
      "[profile  dev]",
      "mfa_serial=arn:aws:iam::1:mfa/dev",
      "",
    ].join("\n");
    expect(parseIni(text)).toEqual({
      default: { region: "eu-west-1" },
      "profile dev": { mfa_serial: "arn:aws:iam::1:mfa/dev" },
    });
  });

  test("indented sub-keys are joined with their parent key; stray lines are ignored", () => {
    const text = ["orphan = 1", "[default]", "s3 =", "  max_concurrent_requests = 20", "region = us-east-1"].join(
      "\r\n",
    );
    expect(parseIni(text)).toEqual({
      default: { s3: "", "s3.max_concurrent_requests": "20", region: "us-east-1" },
    });
  });
});

describe("serializeIni", () => {
  test("round-trips through parseIni", () => {
    const sections = { a: { k: "v", x: "y" }, "b-aws-view": { token: "abc/def+=" } };
    const text = serializeIni(sections);
    expect(text).toBe("[a]\nk = v\nx = y\n\n[b-aws-view]\ntoken = abc/def+=\n");
    expect(parseIni(text)).toEqual(sections);
  });
});
