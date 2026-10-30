import type { Ec2Filter } from "../../core/ec2/filters";
import type { Instance, SsmPing } from "../../core/ec2/model";

export interface AwsTarget {
  readonly profile: string;
  readonly region: string;
}

/** Port: the EC2/SSM calls the extension needs. Credentials come from the signed-in profile. */
export abstract class AwsApi {
  /** Instances matching `filters` (and `ids` when given); `ssm` is left `undefined`. */
  abstract describeInstances(
    target: AwsTarget,
    filters: readonly Ec2Filter[],
    ids?: readonly string[],
  ): Promise<Instance[]>;
  /** SSM agent status by instance ID; instances not registered with SSM are absent. */
  abstract ssmPing(target: AwsTarget, ids?: readonly string[]): Promise<ReadonlyMap<string, SsmPing>>;
  abstract startInstance(target: AwsTarget, id: string): Promise<void>;
  abstract stopInstance(target: AwsTarget, id: string): Promise<void>;
  abstract createTags(target: AwsTarget, id: string, tags: Readonly<Record<string, string>>): Promise<void>;
  abstract deleteTags(target: AwsTarget, id: string, keys: readonly string[]): Promise<void>;
  /** AMI name; `undefined` when the image is gone or cannot be read. */
  abstract imageName(target: AwsTarget, imageId: string): Promise<string | undefined>;
}
