import type { RepoRef } from "../../app/RepoRegistry";
import type { Job, Pipeline } from "../../core/gitlab/model";

export interface NodeCommand {
  readonly command: string;
  readonly title: string;
  readonly arguments?: readonly unknown[];
}

export type TreeNode =
  | { readonly type: "repo"; readonly repo: RepoRef }
  | { readonly type: "pipeline"; readonly repo: RepoRef; readonly pipeline: Pipeline }
  | {
      readonly type: "stage";
      readonly repo: RepoRef;
      readonly pipeline: Pipeline;
      readonly stage: string;
      readonly jobs: readonly Job[];
    }
  | { readonly type: "job"; readonly repo: RepoRef; readonly pipeline: Pipeline; readonly job: Job }
  | { readonly type: "loadMore"; readonly repo: RepoRef }
  | {
      readonly type: "message";
      readonly key: string;
      readonly text: string;
      readonly icon: string;
      readonly tooltip?: string;
      readonly command?: NodeCommand;
    };

/** `pipeline:retry`, `job:play`…: package.json menus match via regex `viewItem =~ /^job.*:play/`. */
export function contextValue(kind: "pipeline" | "job", actions: readonly string[]): string {
  return [kind, ...actions].join(":");
}
