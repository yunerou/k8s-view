import {
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { DescribeInstanceInformationCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, test } from "vitest";
import type { AuthService } from "../../../src/app/AuthService";
import { isCanceled } from "../../../src/core/util/errors";
import { SdkAwsApi } from "../../../src/infra/aws/SdkAwsApi";

const ec2 = mockClient(EC2Client);
const ssm = mockClient(SSMClient);
const auth = {
  profile: () => ({ name: "dev" }),
  credentials: async () => ({ accessKeyId: "A", secretAccessKey: "S" }),
} as unknown as AuthService;
const target = { profile: "dev", region: "eu-west-1" };
let api: SdkAwsApi;

afterEach(() => {
  ec2.reset();
  ssm.reset();
  api?.dispose();
});

describe("SdkAwsApi", () => {
  test("describeInstances follows pages and maps instances", async () => {
    const inputs: unknown[] = [];
    const pages = [
      {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-1",
                InstanceType: "t3.large",
                State: { Name: "running" },
                LaunchTime: new Date("2026-10-30T06:00:00Z"),
                ImageId: "ami-1",
                PlatformDetails: "Linux/UNIX",
                Tags: [
                  { Key: "Name", Value: "dev" },
                  { Key: "Owner", Value: "me" },
                ],
              },
            ],
          },
        ],
        NextToken: "next",
      },
      { Reservations: [{ Instances: [{ InstanceId: "i-2", State: { Name: "stopped" } }] }] },
    ];
    ec2.on(DescribeInstancesCommand).callsFake((input) => {
      inputs.push(structuredClone(input));
      return pages.shift();
    });
    api = new SdkAwsApi(auth);
    const list = await api.describeInstances(target, [{ Name: "instance-state-name", Values: ["running", "stopped"] }]);
    expect(list).toEqual([
      {
        id: "i-1",
        name: "dev",
        type: "t3.large",
        state: "running",
        launchTime: Date.parse("2026-10-30T06:00:00Z"),
        imageId: "ami-1",
        platform: "Linux/UNIX",
        tags: { Name: "dev", Owner: "me" },
        ssm: undefined,
      },
      {
        id: "i-2",
        name: undefined,
        type: "",
        state: "stopped",
        launchTime: undefined,
        imageId: undefined,
        platform: undefined,
        tags: {},
        ssm: undefined,
      },
    ]);
    expect(inputs[0]).toMatchObject({ Filters: [{ Name: "instance-state-name", Values: ["running", "stopped"] }] });
    expect(inputs[1]).toMatchObject({ NextToken: "next" });
  });

  test("describeInstances by ID", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    api = new SdkAwsApi(auth);
    await api.describeInstances(target, [], ["i-1"]);
    expect(ec2.commandCalls(DescribeInstancesCommand)[0]?.args[0].input).toEqual({ Filters: [], InstanceIds: ["i-1"] });
  });

  test("ssmPing maps instance IDs to their ping status", async () => {
    ssm.on(DescribeInstanceInformationCommand).resolves({
      InstanceInformationList: [
        { InstanceId: "i-1", PingStatus: "Online" },
        { InstanceId: "i-2", PingStatus: "ConnectionLost" },
        { InstanceId: "mi-3" },
      ],
    });
    api = new SdkAwsApi(auth);
    expect([...(await api.ssmPing(target))]).toEqual([
      ["i-1", "Online"],
      ["i-2", "ConnectionLost"],
    ]);
    await api.ssmPing(target, ["i-1"]);
    expect(ssm.commandCalls(DescribeInstanceInformationCommand)[1]?.args[0].input).toEqual({
      Filters: [{ Key: "InstanceIds", Values: ["i-1"] }],
    });
  });

  test("start, stop and tags", async () => {
    ec2.on(StartInstancesCommand).resolves({});
    ec2.on(StopInstancesCommand).resolves({});
    ec2.on(CreateTagsCommand).resolves({});
    ec2.on(DeleteTagsCommand).resolves({});
    api = new SdkAwsApi(auth);
    await api.startInstance(target, "i-1");
    await api.stopInstance(target, "i-1");
    await api.createTags(target, "i-1", { Name: "dev", Owner: "me" });
    await api.deleteTags(target, "i-1", ["Old"]);
    await api.deleteTags(target, "i-1", []);
    expect(ec2.commandCalls(StartInstancesCommand)[0]?.args[0].input).toEqual({ InstanceIds: ["i-1"] });
    expect(ec2.commandCalls(StopInstancesCommand)[0]?.args[0].input).toEqual({ InstanceIds: ["i-1"] });
    expect(ec2.commandCalls(CreateTagsCommand)[0]?.args[0].input).toEqual({
      Resources: ["i-1"],
      Tags: [
        { Key: "Name", Value: "dev" },
        { Key: "Owner", Value: "me" },
      ],
    });
    expect(ec2.commandCalls(DeleteTagsCommand).map((c) => c.args[0].input)).toEqual([
      { Resources: ["i-1"], Tags: [{ Key: "Old" }] },
    ]);
  });

  test("imageName, or undefined when the image cannot be read", async () => {
    ec2
      .on(DescribeImagesCommand)
      .resolvesOnce({ Images: [{ Name: "ubuntu/images/x" }] })
      .rejectsOnce(new Error("denied"));
    api = new SdkAwsApi(auth);
    expect(await api.imageName(target, "ami-1")).toBe("ubuntu/images/x");
    expect(await api.imageName(target, "ami-1")).toBeUndefined();
  });
  test("new credentials replace SDK clients after signing in again", async () => {
    let credentials = { accessKeyId: "OLD", secretAccessKey: "S" };
    const currentAuth = {
      profile: () => ({ name: "dev" }),
      credentials: async () => credentials,
    } as unknown as AuthService;
    api = new SdkAwsApi(currentAuth);
    const clients: EC2Client[] = [];
    const keys: string[] = [];
    ec2.on(StartInstancesCommand).callsFake(async (_input, getClient) => {
      const client = getClient();
      clients.push(client);
      keys.push((await client.config.credentials()).accessKeyId);
      return {};
    });
    await api.startInstance(target, "i-1");
    await api.startInstance(target, "i-1");
    credentials = { accessKeyId: "NEW", secretAccessKey: "S" };
    await api.startInstance(target, "i-1");
    expect(keys).toEqual(["OLD", "OLD", "NEW"]);
    expect(clients[0]).toBe(clients[1]);
    expect(clients[2]).not.toBe(clients[0]);
  });

  test("a profile mismatch never sends a request with another account's credentials", async () => {
    api = new SdkAwsApi(auth);
    const error = await api.startInstance({ ...target, profile: "other" }, "i-1").catch((e: unknown) => e);
    expect(isCanceled(error)).toBe(true);
    expect(ec2.commandCalls(StartInstancesCommand)).toHaveLength(0);
  });

  test("switching profile during sign-in cancels before sending to AWS", async () => {
    let name = "dev";
    const switchingAuth = {
      profile: () => ({ name }),
      credentials: async () => {
        name = "other";
        return { accessKeyId: "OTHER", secretAccessKey: "S" };
      },
    } as unknown as AuthService;
    api = new SdkAwsApi(switchingAuth);
    const error = await api.startInstance(target, "i-1").catch((e: unknown) => e);
    expect(isCanceled(error)).toBe(true);
    expect(ec2.commandCalls(StartInstancesCommand)).toHaveLength(0);
  });
});
