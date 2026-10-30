/**
 * Typed protocol between the extension and the tag editor webview (vscode-messenger). Shared by `src/` and
 * `webview-ui/`; only types and constants, no `vscode` imports.
 */
import type { RequestType } from "vscode-messenger-common";
import type { TagRow } from "./tags";

export interface TagEditorInit {
  readonly instanceId: string;
  readonly label: string;
  readonly rows: readonly TagRow[];
  /** `aws:` tags: not shown, never changed. */
  readonly readOnlyCount: number;
}

export const TagRequests = {
  getInit: { method: "tags/getInit" } as RequestType<void, TagEditorInit>,
  /** `{}` on success (the panel then closes), `{ error }` to show on the form. */
  save: { method: "tags/save" } as RequestType<{ rows: readonly TagRow[] }, { readonly error?: string }>,
  cancel: { method: "tags/cancel" } as RequestType<void, void>,
};

export const TAG_EDITOR_VIEW_TYPE = "awsView.tags";
