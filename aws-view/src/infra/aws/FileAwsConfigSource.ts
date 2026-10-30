import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { injectable } from "@needle-di/core";
import { type AwsConfigFiles, AwsConfigSource } from "../../app/ports/AwsConfigSource";
import { type IniSections, parseIni } from "../../core/aws/ini";

@injectable()
export class FileAwsConfigSource extends AwsConfigSource {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly home: string = homedir(),
  ) {
    super();
  }

  async read(): Promise<AwsConfigFiles> {
    const [config, credentials] = await Promise.all([
      readIni(this.env["AWS_CONFIG_FILE"] || join(this.home, ".aws", "config")),
      readIni(this.env["AWS_SHARED_CREDENTIALS_FILE"] || join(this.home, ".aws", "credentials")),
    ]);
    return { config, credentials };
  }
}

async function readIni(path: string): Promise<IniSections> {
  try {
    return parseIni(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
