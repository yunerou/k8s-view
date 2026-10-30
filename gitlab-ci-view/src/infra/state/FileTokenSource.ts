import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { inject, injectable } from "@needle-di/core";
import { GitLabError } from "../../app/ports/GitLabApi";
import { Settings } from "../../app/ports/Settings";
import { TokenFiles } from "../../app/ports/TokenFiles";
import type { Event } from "../../core/util/Emitter";

@injectable()
export class FileTokenSource extends TokenFiles {
  readonly onDidChange: Event<void>;

  constructor(private readonly settings = inject(Settings)) {
    super();
    this.onDidChange = (listener) =>
      settings.onDidChange((keys) => {
        if (keys.includes("hosts")) listener();
      });
  }

  hosts(): readonly string[] {
    return this.settings
      .hosts()
      .filter((h) => h.tokenFile)
      .map((h) => h.host);
  }

  path(host: string): string | undefined {
    return this.settings.hosts().find((h) => h.host === host)?.tokenFile;
  }

  async read(host: string): Promise<string> {
    const configured = this.path(host);
    const path = configured?.replace(/^~(?=$|\/)/, homedir());
    if (!path || !isAbsolute(path)) {
      throw new GitLabError("noToken", `tokenFile for ${host} must be an absolute path or start with ~/.`, host);
    }
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      throw new GitLabError("noToken", `Cannot read tokenFile for ${host}. Check the path and file permissions.`, host);
    }
    const token = content.trim();
    if (!token || /\s/.test(token)) {
      throw new GitLabError("noToken", `tokenFile for ${host} must contain a single non-empty token.`, host);
    }
    return token;
  }
}
