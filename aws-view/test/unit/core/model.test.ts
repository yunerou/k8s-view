import { describe, expect, test } from "vitest";
import {
  byLabel,
  guessSshUser,
  type Instance,
  instanceActions,
  instanceLabel,
  isTransitional,
  sshUserTag,
  toInstanceState,
  toSsmPing,
  uptimeMs,
} from "../../../src/core/ec2/model";

const base: Instance = {
  id: "i-1",
  name: undefined,
  type: "t3.large",
  state: "running",
  launchTime: 1_000,
  imageId: "ami-1",
  platform: "Linux/UNIX",
  tags: {},
  ssm: undefined,
};
const at = (patch: Partial<Instance>): Instance => ({ ...base, ...patch });

describe("EC2 model", () => {
  test("parsing SDK values", () => {
    expect(toInstanceState("stopped")).toBe("stopped");
    expect(toInstanceState(undefined)).toBe("pending");
    expect(toSsmPing("Online")).toBe("Online");
    expect(toSsmPing("Weird")).toBeUndefined();
  });

  test("label, transitional states and actions per state", () => {
    expect(instanceLabel(base)).toBe("i-1");
    expect(instanceLabel(at({ name: "dev" }))).toBe("dev");
    expect(["pending", "stopping", "shutting-down", "running"].map((s) => isTransitional(s as never))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(instanceActions(at({ state: "stopped" }))).toEqual(["start", "remote"]);
    expect(instanceActions(at({ ssm: "Online" }))).toEqual(["remote", "terminal", "stop"]);
    expect(instanceActions(at({ ssm: "ConnectionLost" }))).toEqual(["stop"]);
    expect(instanceActions(at({ state: "pending" }))).toEqual([]);
  });

  test("uptime only while running", () => {
    expect(uptimeMs(base, 61_000)).toBe(60_000);
    expect(uptimeMs(at({ state: "stopped" }), 61_000)).toBeUndefined();
    expect(uptimeMs(at({ launchTime: undefined }), 61_000)).toBeUndefined();
  });

  test("SSH user: tag, then a guess from the AMI name", () => {
    expect(sshUserTag(at({ tags: { "aws-view:ssh-user": " dev " } }))).toBe("dev");
    expect(sshUserTag(at({ tags: { "aws-view:ssh-user": " " } }))).toBeUndefined();
    expect(guessSshUser("ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-20260101")).toBe("ubuntu");
    expect(guessSshUser("debian-12-amd64-20260101")).toBe("admin");
    expect(guessSshUser("al2023-ami-2023.6.20260101.0-kernel-6.1-x86_64")).toBe("ec2-user");
    expect(guessSshUser(undefined)).toBe("ec2-user");
  });

  test("byLabel sorts by name, then ID", () => {
    const list = [at({ id: "i-3", name: "web" }), at({ id: "i-2" }), at({ id: "i-1", name: "api" })];
    expect([...list].sort(byLabel).map((i) => i.id)).toEqual(["i-1", "i-2", "i-3"]);
  });
});
