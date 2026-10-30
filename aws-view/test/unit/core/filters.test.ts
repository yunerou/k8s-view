import { describe, expect, test } from "vitest";
import {
  defaultFilter,
  describeFilter,
  ec2Filters,
  formatTagFilter,
  matchesClient,
  parseTagFilter,
} from "../../../src/core/ec2/filters";
import type { Instance } from "../../../src/core/ec2/model";

const instance = (id: string, name?: string): Instance => ({
  id,
  name,
  type: "t3.micro",
  state: "running",
  launchTime: undefined,
  imageId: undefined,
  platform: undefined,
  tags: {},
  ssm: undefined,
});

describe("instance filters", () => {
  test("server side: tags and states; terminated hidden by default", () => {
    const f = defaultFilter([
      { key: "Owner", values: ["alice", "bob"] },
      { key: "Dev", values: [] },
    ]);
    expect(ec2Filters(f)).toEqual([
      { Name: "tag:Owner", Values: ["alice", "bob"] },
      { Name: "tag-key", Values: ["Dev"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] },
    ]);
    expect(ec2Filters({ ...f, tags: [], states: ["stopped"] })).toEqual([
      { Name: "instance-state-name", Values: ["stopped"] },
    ]);
  });

  test("client side: name or ID substring, pinned only", () => {
    const f = defaultFilter([]);
    const pinned = new Set(["i-2"]);
    expect(matchesClient(instance("i-1", "Web Server"), { ...f, nameContains: "web" }, pinned)).toBe(true);
    expect(matchesClient(instance("i-0abc"), { ...f, nameContains: "0ab" }, pinned)).toBe(true);
    expect(matchesClient(instance("i-1", "api"), { ...f, nameContains: "web" }, pinned)).toBe(false);
    expect(matchesClient(instance("i-1"), { ...f, pinnedOnly: true }, pinned)).toBe(false);
    expect(matchesClient(instance("i-2"), { ...f, pinnedOnly: true }, pinned)).toBe(true);
  });

  test("describe, parse and format", () => {
    expect(describeFilter(defaultFilter([]))).toBeUndefined();
    expect(
      describeFilter({
        tags: [{ key: "Owner", values: ["alice"] }],
        states: ["running"],
        nameContains: " web ",
        pinnedOnly: true,
      }),
    ).toBe('Owner=alice · running · "web" · pinned');
    expect(parseTagFilter(" Env = dev | test ")).toEqual({ key: "Env", values: ["dev", "test"] });
    expect(parseTagFilter("Owner")).toEqual({ key: "Owner", values: [] });
    expect(parseTagFilter("  ")).toBeUndefined();
    expect(parseTagFilter("=x")).toBeUndefined();
    expect(formatTagFilter({ key: "Env", values: ["dev", "test"] })).toBe("Env=dev|test");
  });
});
