import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicFile } from "./atomicFile";
import { defaultMcpDirectory } from "./DiscoveryFile";

export class BridgeInstaller {
  readonly path: string;
  constructor(
    private readonly source: string,
    baseDirectory = defaultMcpDirectory(),
  ) {
    this.path = join(baseDirectory, "mcp-bridge.js");
  }
  async install(): Promise<void> {
    const content = await readFile(this.source);
    try {
      if (content.equals(await readFile(this.path))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicFile(this.path, content);
  }
}
