import { type Instance, instanceActions } from "../../core/ec2/model";

export interface NodeCommand {
  readonly command: string;
  readonly title: string;
  readonly arguments?: readonly unknown[];
}

export type TreeNode =
  | { readonly type: "instance"; readonly instance: Instance; readonly pinned: boolean }
  | {
      readonly type: "message";
      readonly key: string;
      readonly text: string;
      readonly icon: string;
      readonly command?: NodeCommand;
    };

/** `instance:remote:terminal:stop:pinned`: package.json menus match it with regexes such as `/^instance.*:stop/`. */
export function contextValue(i: Instance, pinned: boolean): string {
  return ["instance", ...instanceActions(i), pinned ? "pinned" : "unpinned"].join(":");
}
