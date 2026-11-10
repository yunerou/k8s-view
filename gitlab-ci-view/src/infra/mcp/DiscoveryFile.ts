import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicFile } from "./atomicFile";
import type { Endpoint } from "./McpHttpServer";

export const defaultMcpDirectory = () => join(homedir(), ".gitlab-ci-view");

export class DiscoveryFile {
  readonly path: string;
  constructor(
    readonly baseDirectory = defaultMcpDirectory(),
    readonly pid = process.pid,
  ) {
    this.path = join(baseDirectory, "mcp", `${pid}.json`);
  }
  async publish(endpoint: Endpoint, workspaceFolders: readonly string[]): Promise<void> {
    await mkdir(this.baseDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.baseDirectory, 0o700);
    await atomicFile(this.path, JSON.stringify({ version: 1, pid: this.pid, ...endpoint, workspaceFolders }));
  }
  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
