/** Origin of a view/command definition, in load order (later sources win). */
/** `remote`: JSON downloaded from URLs in `k8sView.remoteConfigs` (gists, etc.); commands run only if allowlisted. */
export type ConfigOrigin = "builtin" | "preset" | "remote" | "user" | "workspace";

export const ORIGIN_ORDER: readonly ConfigOrigin[] = ["builtin", "preset", "remote", "user", "workspace"];
