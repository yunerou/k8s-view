import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { decodeSecretData } from "../../../src/core/resource/secretData";
import { secretYaml } from "../../../src/ui/secretYaml";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

describe("decodeSecretData", () => {
  test("text values are decoded, binary values keep base64, keys sorted", () => {
    const binary = Buffer.from([0xff, 0x00, 0x10, 0x80]);
    expect(decodeSecretData({ password: b64("s3cr3t"), "tls.key": b64(binary), config: b64("a: 1\nb: 2\n") })).toEqual([
      { key: "config", type: "text", text: "a: 1\nb: 2\n" },
      { key: "password", type: "text", text: "s3cr3t" },
      { key: "tls.key", type: "binary", size: 4, base64: binary.toString("base64") },
    ]);
    expect(decodeSecretData(undefined)).toEqual([]);
  });
});

describe("secretYaml", () => {
  test("stringData for text, data for binary, warning header", () => {
    const ref = { context: "dev", group: "", kind: "Secret", namespace: "app", name: "db" };
    const text = secretYaml(
      ref,
      "Opaque",
      decodeSecretData({ user: b64("admin"), multi: b64("line1\nline2"), bin: b64(Buffer.from([0, 1])) }),
    );
    expect(text).toMatch(/^# Decoded Secret app\/db — context dev/);
    expect(text).toContain("# 'bin' is binary (2 bytes)");
    expect(parse(text)).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db", namespace: "app" },
      type: "Opaque",
      stringData: { multi: "line1\nline2", user: "admin" },
      data: { bin: "AAE=" },
    });
  });
});
