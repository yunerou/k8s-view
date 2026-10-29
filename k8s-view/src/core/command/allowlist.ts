import type { RunConfig } from "../config/schema";
import type { RenderedRun } from "./CommandTemplate";
import { splitCommandLine } from "./commandLine";

/**
 * Remote config command allowlist (`k8sView.remoteConfigs[].allowCommands`). No patterns by default = block all.
 *
 * argv patterns: `<command> <arg 1> [args…] [**]` — match each argument; standalone `*` = exactly one arbitrary argument,
 * `*` within a token = any substring within that argument (`--namespace=*`); trailing `**` = remaining arguments.
 * The command and first argument must be literals (no wildcards or flags): `kubectl **` or `kubectl -n x **` would also allow
 * `kubectl exec`, so they are rejected. VS Code commands: `vscode:<command id>`.
 */
export class CommandAllowlist {
  static readonly empty = new CommandAllowlist([]);

  private constructor(readonly patterns: readonly CommandPattern[]) {}

  /** Invalid patterns are skipped and returned in `errors`. */
  static parse(sources: readonly string[]): { allowlist: CommandAllowlist; errors: string[] } {
    const patterns: CommandPattern[] = [];
    const errors: string[] = [];
    for (const source of sources) {
      const parsed = parsePattern(source);
      if (typeof parsed === "string") errors.push(`'${source}': ${parsed}`);
      else patterns.push(parsed);
    }
    return { allowlist: new CommandAllowlist(patterns), errors };
  }

  /** Validate at config load; templated arguments match only wildcards (actual values are checked again at execution). */
  admit(run: RunConfig): string | undefined {
    if (run.type === "batch") return "Native batch commands cannot be loaded from remote configs";
    if (run.type === "vscode") return this.checkVscode(run.command);
    if (run.type !== "kubectl" && (run.cwd !== undefined || run.env !== undefined)) {
      return "'cwd' and 'env' are not allowed in remote commands";
    }
    const argv = run.type === "kubectl" ? ["kubectl", ...run.args] : [run.command, ...run.args];
    const masked = argv.map((a, i) => (i > 0 && a.includes("${") ? null : a));
    return checkFlags(argv, CONTEXT_TEMPLATE) ?? this.matchArgv(masked);
  }

  /** Validate rendered argv immediately before execution; `context` = execution context (`--context` must match it). */
  check(run: RenderedRun, context: string): string | undefined {
    if (run.type === "batch") return "Native batch commands cannot be loaded from remote configs";
    if (run.type === "vscode") return this.checkVscode(run.command);
    if (run.type !== "kubectl" && (run.cwd !== undefined || run.env !== undefined)) {
      return "'cwd' and 'env' are not allowed in remote commands";
    }
    const argv = run.type === "kubectl" ? ["kubectl", ...run.args] : [run.command, ...run.args];
    return checkFlags(argv, context) ?? this.matchArgv(argv);
  }

  private checkVscode(command: string): string | undefined {
    if (this.patterns.some((p) => p.type === "vscode" && p.command === command)) return undefined;
    return `'vscode:${command}' is not in allowCommands`;
  }

  /** `null` entry = templated argument with an unknown value. */
  private matchArgv(argv: readonly (string | null)[]): string | undefined {
    if (this.patterns.some((p) => p.type === "argv" && matchTokens(p.tokens, argv))) return undefined;
    const shown = argv.slice(0, 2).map((a) => a ?? "${…}");
    return `'${shown.join(" ")}${argv.length > 2 ? " …" : ""}' does not match allowCommands`;
  }
}

type CommandPattern =
  | { readonly type: "argv"; readonly source: string; readonly tokens: readonly string[] }
  | { readonly type: "vscode"; readonly source: string; readonly command: string };

/**
 * Shells, interpreters, and wrappers (execute other commands from arguments): allowing them permits anything,
 * so no pattern may start with them.
 */
const WRAPPERS = new Set(
  (
    "sh bash zsh fish dash ksh mksh csh tcsh ash busybox cmd powershell pwsh wsl env xargs sudo doas su runas nohup " +
    "nice ionice timeout watch time exec eval command builtin parallel script ssh python python2 python3 node nodejs " +
    "deno bun perl ruby php lua osascript wscript cscript awk gawk mawk nawk find"
  ).split(" "),
);

/** Flags changing connection targets or identity: `kubectl get ** --server=https://x` sends your token to another server. */
const CONNECTION_FLAGS = new Set([
  "--server",
  "--kubeconfig",
  "--token",
  "--as",
  "--as-group",
  "--as-uid",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--insecure-skip-tls-verify",
  "--tls-server-name",
  "--username",
  "--password",
  "--cluster",
  "--user",
  "--kube-apiserver",
  "--kube-token",
  "--kube-as-user",
  "--kube-as-group",
  "--kube-ca-file",
  "--kube-insecure-skip-tls-verify",
  "--kube-tls-server-name",
]);
const CONTEXT_FLAGS = new Set(["--context", "--kube-context"]);
const CONTEXT_TEMPLATE = "${context}";

function parsePattern(source: string): CommandPattern | string {
  const text = source.trim();
  if (text.startsWith("vscode:")) {
    const command = text.slice("vscode:".length);
    if (!/^[A-Za-z0-9_.-]+$/.test(command)) return "expected 'vscode:<command id>' without wildcards";
    return { type: "vscode", source, command };
  }
  let tokens: string[];
  try {
    tokens = splitCommandLine(text);
  } catch (e) {
    return (e as Error).message;
  }
  if (tokens.length < 2) return "name the command and its first argument, e.g. 'kubectl get **'";
  const [command, first] = tokens as [string, string];
  if (command.includes("*") || first.includes("*")) {
    return "no wildcard in the command or its first argument ('kubectl **' would also allow 'kubectl exec')";
  }
  if (WRAPPERS.has(baseName(command))) return `'${command}' runs other programs and cannot be allowed`;
  if (first.startsWith("-")) return "the first argument must be a subcommand, not a flag";
  if (tokens.some((t) => t.includes("${"))) return "templates are not allowed in patterns";
  const doubleStar = tokens.findIndex((t) => t.includes("**"));
  if (doubleStar >= 0 && (doubleStar !== tokens.length - 1 || tokens[doubleStar] !== "**")) {
    return "'**' must be the last token, on its own";
  }
  return { type: "argv", source, tokens };
}

function baseName(command: string): string {
  return command
    .slice(Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\")) + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

function matchTokens(tokens: readonly string[], argv: readonly (string | null)[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "**") return true;
    if (i >= argv.length || !matchToken(tokens[i]!, argv[i]!)) return false;
  }
  return tokens.length === argv.length;
}

function matchToken(token: string, arg: string | null): boolean {
  if (token === "*") return true;
  if (!token.includes("*")) return arg === token;
  if (arg === null) return true;
  const regex = new RegExp(`^${token.split("*").map(escapeRegex).join(".*")}$`, "s");
  return regex.test(arg);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Connection flags are forbidden; `--context` may only reference `context` (literal `${context}` at load, context name at execution).
 * Arguments after `--` are the in-container command and are ignored.
 */
function checkFlags(argv: readonly string[], context: string): string | undefined {
  const isKubectl = baseName(argv[0] ?? "") === "kubectl";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (CONNECTION_FLAGS.has(name) || (isKubectl && name === "-s")) {
      return `'${name}' cannot be used by remote commands`;
    }
    if (!CONTEXT_FLAGS.has(name)) continue;
    const value = eq < 0 ? argv[i + 1] : arg.slice(eq + 1);
    if (value !== context) return `'${name}' must be ${CONTEXT_TEMPLATE} in remote commands`;
  }
  return undefined;
}
