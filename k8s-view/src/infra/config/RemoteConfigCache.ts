import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import type { RemoteConfigSetting } from "../../app/ports/Settings";
import { EXTENSION_CONTEXT, LOGGER } from "../../di/tokens";
import { downloadRemoteConfig, type FetchLike, sha256 } from "./remoteConfig";

export interface RemoteRefreshResult {
  readonly url: string;
  readonly changed: boolean;
  readonly error?: string;
}

/**
 * Remote config content, stored in globalStorage for offline use and as a target for Problems diagnostics.
 * Only validated content (HTTPS, size, `sha256` if specified) is cached.
 */
@injectable()
export class RemoteConfigCache {
  private readonly memory = new Map<string, string>();
  fetchImpl: FetchLike = fetch;

  constructor(
    private readonly context = inject(EXTENSION_CONTEXT),
    private readonly log = inject(LOGGER),
  ) {}

  /** Cache file for a URL (config file ID in ConfigLoader). */
  uriOf(url: string): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "remote-configs", `${sha256(url).slice(0, 16)}.json`);
  }

  /** Previously fetched content (memory, then disk); `undefined` if not yet fetched or `sha256` does not match. */
  async read(source: RemoteConfigSetting): Promise<string | undefined> {
    let text = this.memory.get(source.url);
    if (text === undefined) {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uriOf(source.url)));
      } catch {
        return undefined;
      }
      this.memory.set(source.url, text);
    }
    if (source.sha256 && sha256(text) !== source.sha256) {
      this.log.warn(`Remote config ${source.url}: cached content does not match sha256, ignored`);
      return undefined;
    }
    return text;
  }

  async refresh(source: RemoteConfigSetting): Promise<RemoteRefreshResult> {
    try {
      const text = await downloadRemoteConfig(source.url, this.fetchImpl);
      if (source.sha256 && sha256(text) !== source.sha256) {
        throw new Error(`content sha256 ${sha256(text)} does not match the pinned sha256`);
      }
      if ((await this.read(source)) === text) return { url: source.url, changed: false };
      const uri = this.uriOf(source.url);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
      this.memory.set(source.url, text);
      this.log.info(`Remote config ${source.url} updated`);
      return { url: source.url, changed: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`Cannot fetch remote config ${source.url}: ${error}`);
      return { url: source.url, changed: false, error };
    }
  }
}
