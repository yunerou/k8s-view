import { expandHome } from "../util/paths";

const HOST_PREFIX = "aws-view-";
const HEADER = "# Managed by AWS View: changes to this file are overwritten.";

export function sshAlias(instanceId: string): string {
  return `${HOST_PREFIX}${instanceId}`;
}

export function remoteAuthority(instanceId: string): string {
  return `ssh-remote+${sshAlias(instanceId)}`;
}

export function instanceIdFromAuthority(authority: string | undefined): string | undefined {
  return /^ssh-remote\+aws-view-(i-[0-9a-f]+)$/.exec(authority ?? "")?.[1];
}

export function homeDir(user: string): string {
  return user === "root" ? "/root" : `/home/${user}`;
}

function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("SSH configuration values must fit on one line.");
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/** Path value in ssh_config: `%` escaped (token expansion), double-quoted when it contains spaces. */
export function sshPath(path: string): string {
  return quote(path.replace(/%/g, "%%"));
}

export interface HostBlockInput {
  readonly instanceId: string;
  readonly label: string;
  readonly user: string;
  readonly identityFiles: readonly string[];
  readonly knownHostsFile: string;
  readonly proxyCommand: string;
}

export function renderHostBlock(h: HostBlockInput): string {
  if (!/^i-[0-9a-f]+$/.test(h.instanceId)) throw new Error("Invalid EC2 instance ID.");
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(h.user)) throw new Error("Invalid SSH user name.");
  return [
    `Host ${sshAlias(h.instanceId)}`,
    `  # ${h.label.replace(/[\r\n]+/g, " ")}`,
    `  HostName ${h.instanceId}`,
    `  User ${h.user}`,
    ...h.identityFiles.map((f) => `  IdentityFile ${sshPath(f)}`),
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${sshPath(h.knownHostsFile)}`,
    "  StrictHostKeyChecking accept-new",
    `  ProxyCommand ${h.proxyCommand}`,
  ].join("\n");
}

/** Replace (or append) the block of `alias`; other hosts are kept and the header is rewritten. */
export function upsertHostBlock(text: string, alias: string, block: string): string {
  const others = splitHostBlocks(text)
    .filter((b) => b.alias !== alias)
    .map((b) => b.text);
  return `${[HEADER, ...others, block].join("\n\n")}\n`;
}

function splitHostBlocks(text: string): { alias: string; text: string }[] {
  return text
    .replace(/^# Managed by AWS View: changes to this file are overwritten\.\r?\n?/, "")
    .split(/(?=^\s*Host[ \t]+)/im)
    .map((part) => ({ alias: /^\s*Host[ \t]+(\S+)/i.exec(part)?.[1] ?? "", text: part.trim() }))
    .filter((part) => part.text.length > 0);
}

/** `Include ~/.ssh/aws-view.config` (shown with `~` when the file is under the home directory). */
export function includeLine(configPath: string, home: string): string {
  const shown = configPath.startsWith(`${home}/`) ? `~${configPath.slice(home.length)}` : configPath;
  return `Include ${quote(shown)}`;
}

/** Relative Include paths are relative to `~/.ssh`. */
function resolveInclude(arg: string, home: string): string {
  if (arg.startsWith("/") || arg.startsWith("~")) return expandHome(arg, home);
  return `${home}/.ssh/${arg}`;
}

export function hasInclude(configText: string, configPath: string, home: string): boolean {
  const globalLines = configText.split(/\r?\n/);
  const firstBlock = globalLines.findIndex((line) => /^\s*(?:Host|Match)\s/i.test(line));
  return (firstBlock < 0 ? globalLines : globalLines.slice(0, firstBlock)).some((line) => {
    const args = /^\s*Include\s+(.+?)\s*$/i.exec(line)?.[1];
    if (!args) return false;
    return [...args.matchAll(/"([^"]*)"|(\S+)/g)].some((a) => resolveInclude(a[1] ?? a[2] ?? "", home) === configPath);
  });
}

/** `Include` applies to every host only when it comes before the first `Host`/`Match`: put it at the very top. */
export function addInclude(configText: string, configPath: string, home: string): string {
  if (hasInclude(configText, configPath, home)) return configText;
  return `# Added by AWS View\n${includeLine(configPath, home)}\n\n${configText}`;
}
