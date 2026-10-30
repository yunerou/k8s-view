import { describe, expect, test } from "vitest";
import { diffTags, editableRows, isAwsTag, validateTags } from "../../../src/shared/tags";

describe("tags", () => {
  test("aws: tags are hidden from the editor", () => {
    expect(isAwsTag("aws:cloudformation:stack-name")).toBe(true);
    expect(isAwsTag("AWS:x")).toBe(true);
    expect(isAwsTag("Owner")).toBe(false);
    expect(editableRows({ Owner: "me", "aws:autoscaling:groupName": "g", Env: "dev" })).toEqual([
      { key: "Env", value: "dev" },
      { key: "Owner", value: "me" },
    ]);
  });

  test("validation per row; blank rows are ignored", () => {
    const rows = [
      { key: "Name", value: "box" },
      { key: "", value: "" },
      { key: "", value: "orphan" },
      { key: "aws:x", value: "1" },
      { key: "Name ", value: "dup" },
      { key: "k".repeat(129), value: "" },
      { key: "Long", value: "v".repeat(257) },
    ];
    expect(validateTags(rows)).toEqual({
      rows: [
        undefined,
        undefined,
        "Key is required",
        "Keys starting with aws: are reserved",
        "Duplicate key",
        "Key is longer than 128 characters",
        "Value is longer than 256 characters",
      ],
    });
    const many = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, value: "" }));
    expect(validateTags(many).error).toBe("An instance can have at most 50 tags.");
  });

  test("diff deletes removed keys, writes new and changed ones, never deletes aws: tags", () => {
    const before = { Name: "box", Owner: "me", Old: "x", "aws:cloudformation:stack-name": "s" };
    expect(
      diffTags(before, [
        { key: "Name", value: "box" },
        { key: " Owner ", value: "you" },
        { key: "Env", value: "" },
        { key: "", value: "" },
      ]),
    ).toEqual({ toCreate: { Owner: "you", Env: "" }, toDelete: ["Old"] });
  });
  test("diff never writes reserved tags and supports ordinary object property names", () => {
    expect(
      diffTags({}, [
        { key: "aws:managed", value: "no" },
        { key: "AWS:managed", value: "no" },
        { key: "__proto__", value: "custom" },
        { key: "constructor", value: "custom" },
      ]),
    ).toEqual({
      toCreate: JSON.parse('{"__proto__":"custom","constructor":"custom"}'),
      toDelete: [],
    });
  });
});
