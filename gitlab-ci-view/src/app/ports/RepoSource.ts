import type { RemoteInfo } from "../../core/remote/remote";
import type { Event } from "../../core/util/Emitter";

export interface GitRepoInfo {
  /** Repository root directory URI (`Uri.toString()`), used as its ID. */
  readonly rootUri: string;
  /** Directory name. */
  readonly name: string;
  readonly remotes: readonly RemoteInfo[];
  /** Checked-out branch; `undefined` for detached HEAD. */
  readonly branch: string | undefined;
}

/** Port: Git repositories open in the workspace. */
export abstract class RepoSource {
  abstract readonly onDidChange: Event<void>;
  abstract repositories(): readonly GitRepoInfo[];
}
