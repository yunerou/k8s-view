import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inject, injectable } from "@needle-di/core";
import { CredentialFile } from "../../app/ports/CredentialFile";
import type { AwsCredentials } from "../../core/aws/credentials";
import { type IniSections, parseIni, serializeIni } from "../../core/aws/ini";
import { EXTENSION_CONTEXT } from "../../di/tokens";

/** Unknown keys are ignored by the AWS CLI: the expiration travels with the keys, so other windows can reuse them. */
const EXPIRATION_KEY = "aws_view_expiration";

@injectable()
export class FileCredentialFile extends CredentialFile {
  readonly path: string;

  constructor(private readonly storageDir: string = inject(EXTENSION_CONTEXT).globalStorageUri.fsPath) {
    super();
    this.path = join(storageDir, "credentials");
  }

  async read(profile: string): Promise<AwsCredentials | undefined> {
    const s = (await this.load())[profile];
    const accessKeyId = s?.["aws_access_key_id"];
    const secretAccessKey = s?.["aws_secret_access_key"];
    if (!s || !accessKeyId || !secretAccessKey) return undefined;
    const sessionToken = s["aws_session_token"];
    const expiration = s[EXPIRATION_KEY] ? new Date(s[EXPIRATION_KEY]) : undefined;
    if ((expiration && Number.isNaN(expiration.getTime())) || (sessionToken && !expiration)) return undefined;
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(expiration && !Number.isNaN(expiration.getTime()) ? { expiration } : {}),
    };
  }

  async write(profile: string, c: AwsCredentials): Promise<void> {
    const sections = { ...(await this.load()) };
    sections[profile] = {
      aws_access_key_id: c.accessKeyId,
      aws_secret_access_key: c.secretAccessKey,
      ...(c.sessionToken ? { aws_session_token: c.sessionToken } : {}),
      ...(c.expiration ? { [EXPIRATION_KEY]: c.expiration.toISOString() } : {}),
    };
    await this.save(sections);
  }

  async remove(profile: string): Promise<void> {
    const sections = await this.load();
    if (!(profile in sections)) return;
    await this.save(Object.fromEntries(Object.entries(sections).filter(([name]) => name !== profile)));
  }

  private async load(): Promise<Record<string, Readonly<Record<string, string>>>> {
    try {
      return { ...parseIni(await readFile(this.path, "utf8")) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  /** Write a temp file then rename, so the AWS CLI never reads a half-written file. */
  private async save(sections: IniSections): Promise<void> {
    await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, serializeIni(sections), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }
}
