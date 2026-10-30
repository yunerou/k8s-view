import type { IniSections } from "../../core/aws/ini";

export interface AwsConfigFiles {
  readonly config: IniSections;
  readonly credentials: IniSections;
}

/** Port: the user's `~/.aws/config` and `~/.aws/credentials` (read-only). */
export abstract class AwsConfigSource {
  abstract read(): Promise<AwsConfigFiles>;
}
