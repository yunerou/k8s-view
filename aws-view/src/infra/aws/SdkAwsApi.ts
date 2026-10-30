import {
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeImagesCommand,
  EC2Client,
  paginateDescribeInstances,
  type Instance as SdkInstance,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { paginateDescribeInstanceInformation, SSMClient } from "@aws-sdk/client-ssm";
import { inject, injectable } from "@needle-di/core";
import { AuthService } from "../../app/AuthService";
import { AwsApi, type AwsTarget } from "../../app/ports/AwsApi";
import type { AwsCredentials } from "../../core/aws/credentials";
import type { Ec2Filter } from "../../core/ec2/filters";
import { type Instance, type SsmPing, toInstanceState, toSsmPing } from "../../core/ec2/model";
import type { Disposable } from "../../core/util/Emitter";
import { CanceledError } from "../../core/util/errors";

@injectable()
export class SdkAwsApi extends AwsApi implements Disposable {
  private readonly ec2 = new Map<string, { client: EC2Client; credentials: AwsCredentials }>();
  private readonly ssm = new Map<string, { client: SSMClient; credentials: AwsCredentials }>();

  constructor(private readonly auth = inject(AuthService)) {
    super();
  }

  async describeInstances(
    target: AwsTarget,
    filters: readonly Ec2Filter[],
    ids?: readonly string[],
  ): Promise<Instance[]> {
    const input = {
      Filters: filters.map((f) => ({ Name: f.Name, Values: [...f.Values] })),
      ...(ids?.length ? { InstanceIds: [...ids] } : {}),
    };
    const out: Instance[] = [];
    for await (const page of paginateDescribeInstances({ client: await this.ec2Client(target) }, input)) {
      for (const reservation of page.Reservations ?? []) {
        for (const i of reservation.Instances ?? []) if (i.InstanceId) out.push(toInstance(i));
      }
    }
    return out;
  }

  async ssmPing(target: AwsTarget, ids?: readonly string[]): Promise<ReadonlyMap<string, SsmPing>> {
    const input = ids?.length ? { Filters: [{ Key: "InstanceIds", Values: [...ids] }] } : {};
    const result = new Map<string, SsmPing>();
    for await (const page of paginateDescribeInstanceInformation({ client: await this.ssmClient(target) }, input)) {
      for (const info of page.InstanceInformationList ?? []) {
        const ping = toSsmPing(info.PingStatus);
        if (info.InstanceId && ping) result.set(info.InstanceId, ping);
      }
    }
    return result;
  }

  async startInstance(target: AwsTarget, id: string): Promise<void> {
    await (await this.ec2Client(target)).send(new StartInstancesCommand({ InstanceIds: [id] }));
  }

  async stopInstance(target: AwsTarget, id: string): Promise<void> {
    await (await this.ec2Client(target)).send(new StopInstancesCommand({ InstanceIds: [id] }));
  }

  async createTags(target: AwsTarget, id: string, tags: Readonly<Record<string, string>>): Promise<void> {
    const list = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
    await (await this.ec2Client(target)).send(new CreateTagsCommand({ Resources: [id], Tags: list }));
  }

  async deleteTags(target: AwsTarget, id: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await (await this.ec2Client(target)).send(
      new DeleteTagsCommand({ Resources: [id], Tags: keys.map((Key) => ({ Key })) }),
    );
  }

  async imageName(target: AwsTarget, imageId: string): Promise<string | undefined> {
    const client = await this.ec2Client(target);
    try {
      const out = await client.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
      return out.Images?.[0]?.Name;
    } catch {
      // Deregistered image or missing ec2:DescribeImages: the caller falls back to a default user.
      return undefined;
    }
  }

  dispose(): void {
    for (const { client } of [...this.ec2.values(), ...this.ssm.values()]) client.destroy();
    this.ec2.clear();
    this.ssm.clear();
  }

  /** Pin every request to the selected account, even if a profile changes while sign-in is pending. */
  private async authorizedCredentials(target: AwsTarget): Promise<AwsCredentials> {
    if (this.auth.profile()?.name !== target.profile) throw new CanceledError();
    const credentials = await this.auth.credentials();
    if (this.auth.profile()?.name !== target.profile) throw new CanceledError();
    return credentials;
  }

  private async ec2Client(t: AwsTarget): Promise<EC2Client> {
    const credentials = await this.authorizedCredentials(t);
    const key = `${t.profile}|${t.region}`;
    let entry = this.ec2.get(key);
    // SDK providers memoize static credentials forever. Recreate the client when AuthService replaces them.
    if (entry?.credentials !== credentials) {
      entry?.client.destroy();
      entry = { client: new EC2Client({ region: t.region, credentials }), credentials };
      this.ec2.set(key, entry);
    }
    return entry.client;
  }

  private async ssmClient(t: AwsTarget): Promise<SSMClient> {
    const credentials = await this.authorizedCredentials(t);
    const key = `${t.profile}|${t.region}`;
    let entry = this.ssm.get(key);
    if (entry?.credentials !== credentials) {
      entry?.client.destroy();
      entry = { client: new SSMClient({ region: t.region, credentials }), credentials };
      this.ssm.set(key, entry);
    }
    return entry.client;
  }
}

function toInstance(i: SdkInstance): Instance {
  const tags: Record<string, string> = {};
  for (const t of i.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? "";
  return {
    id: i.InstanceId ?? "",
    name: tags["Name"] || undefined,
    type: i.InstanceType ?? "",
    state: toInstanceState(i.State?.Name),
    launchTime: i.LaunchTime?.getTime(),
    imageId: i.ImageId,
    platform: i.PlatformDetails,
    tags,
    ssm: undefined,
  };
}
