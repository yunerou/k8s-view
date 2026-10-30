import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inject, injectable } from "@needle-di/core";
import { Runner } from "../../app/ports/Runner";
import { Settings } from "../../app/ports/Settings";
import { type KeyPair, SshConfigStore } from "../../app/ports/SshConfigStore";
import { addInclude, hasInclude, upsertHostBlock } from "../../core/ssh/hostBlock";
import { EXTENSION_CONTEXT } from "../../di/tokens";

@injectable()
export class FileSshConfigStore extends SshConfigStore {
  readonly knownHostsFile: string;

  constructor(
    private readonly settings = inject(Settings),
    private readonly runner = inject(Runner),
    private readonly storageDir: string = inject(EXTENSION_CONTEXT).globalStorageUri.fsPath,
    private readonly home: string = homedir(),
  ) {
    super();
    this.knownHostsFile = join(storageDir, "known_hosts");
  }

  async hasInclude(): Promise<boolean> {
    return hasInclude(await readText(this.userConfig()), this.settings.sshConfigPath(), this.home);
  }

  async addInclude(): Promise<void> {
    const path = this.userConfig();
    const text = await readText(path);
    if (hasInclude(text, this.settings.sshConfigPath(), this.home)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (text) await copyFile(path, `${path}.aws-view.bak`);
    await writeFile(path, addInclude(text, this.settings.sshConfigPath(), this.home), { mode: 0o600 });
  }

  async upsertHost(alias: string, block: string): Promise<void> {
    const path = this.settings.sshConfigPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, upsertHostBlock(await readText(path), alias, block), { mode: 0o600 });
  }

  async ensureKeyPair(): Promise<KeyPair> {
    const privateKey = join(this.storageDir, "id_ed25519");
    const publicKey = `${privateKey}.pub`;
    if ((await exists(privateKey)) && (await exists(publicKey))) return { privateKey, publicKey };
    await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    await rm(privateKey, { force: true });
    await rm(publicKey, { force: true });
    const r = await this.runner.run("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "aws-view",
      "-f",
      privateKey,
    ]);
    if (r.code !== 0) throw new Error(`ssh-keygen failed: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
    return { privateKey, publicKey };
  }

  private userConfig(): string {
    return join(this.home, ".ssh", "config");
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
