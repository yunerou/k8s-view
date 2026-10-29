export type DangerousSetting = "restricted" | "confirm" | "allow";

export interface ExecutionFacts {
  readonly dangerous: boolean;
  /** Whether the command declares `confirm`. */
  readonly hasConfirm: boolean;
  /** Effective `skipConfirm` (user config files only). */
  readonly skipConfirm: boolean;
  readonly setting: DangerousSetting;
  readonly contextProtected: boolean;
}

export type ExecutionDecision =
  | { readonly action: "block"; readonly reason: string }
  | { readonly action: "confirm"; readonly reason: "protected" | "dangerous" | "declared" }
  | { readonly action: "run" };

/**
 * Command execution policy: dangerous commands are blocked under `restricted`; protected contexts always prompt,
 * even with `allow` or `skipConfirm`.
 */
export function decideExecution(f: ExecutionFacts): ExecutionDecision {
  if (f.dangerous && f.setting === "restricted") {
    return {
      action: "block",
      reason: "Dangerous commands are disabled. Set 'k8sView.commands.dangerous' to 'confirm' or 'allow'.",
    };
  }
  if (f.contextProtected) return { action: "confirm", reason: "protected" };
  if (f.skipConfirm) return { action: "run" };
  if (f.dangerous) return f.setting === "allow" ? { action: "run" } : { action: "confirm", reason: "dangerous" };
  if (f.hasConfirm) return { action: "confirm", reason: "declared" };
  return { action: "run" };
}
