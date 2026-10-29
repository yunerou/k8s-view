/** Repository location extracted from a Git remote URL. */
export interface RemoteLocation {
  /** Lowercase hostname (may be an alias in ~/.ssh/config for SSH). */
  readonly host: string;
  /** Path after the host, without leading/trailing `/` or a `.git` suffix. */
  readonly path: string;
  /** HTTP(S) remote port; SSH ports are irrelevant to the API and are omitted. */
  readonly port?: number;
}

/** An entry in `gitlabCiView.hosts`. */
export interface HostSetting {
  readonly host: string;
  readonly apiUrl?: string;
  readonly sshAlias?: string;
  readonly caFile?: string;
  readonly rejectUnauthorized?: boolean;
}

export interface HostTarget {
  /** Host key: tokens and settings are associated with this key. */
  readonly host: string;
  /** Instance base URL, without a trailing `/` (may include a relative URL root). */
  readonly apiUrl: string;
}

export interface GitLabTarget extends HostTarget {
  readonly projectPath: string;
}

export interface RemoteInfo {
  readonly name: string;
  readonly fetchUrl?: string | undefined;
  readonly pushUrl?: string | undefined;
}

export const GITLAB_COM = "gitlab.com";

/** `user@host:path` (Git's scp syntax). */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/;

export function parseRemoteUrl(url: string): RemoteLocation | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return parseUrlForm(trimmed);
  const m = SCP_LIKE.exec(trimmed);
  if (!m) return undefined;
  const path = cleanPath(m[2]!);
  return path ? { host: m[1]!.toLowerCase(), path } : undefined;
}

function parseUrlForm(raw: string): RemoteLocation | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const web = scheme === "https" || scheme === "http";
  if (!web && scheme !== "ssh" && scheme !== "git+ssh") return undefined;
  let path: string;
  try {
    path = cleanPath(decodeURIComponent(u.pathname));
  } catch {
    return undefined;
  }
  if (!u.hostname || !path) return undefined;
  const host = u.hostname.toLowerCase();
  return web && u.port ? { host, path, port: Number(u.port) } : { host, path };
}

function cleanPath(p: string): string {
  return p
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function findSetting(name: string, hosts: readonly HostSetting[]): HostSetting | undefined {
  const n = name.toLowerCase();
  return hosts.find((h) => h.host.toLowerCase() === n || h.sshAlias?.toLowerCase() === n);
}

/** API target for a host (used when setting a token for a host without a repository). */
export function hostTarget(host: string, hosts: readonly HostSetting[]): HostTarget {
  const setting = findSetting(host, hosts);
  const key = (setting?.host ?? host).toLowerCase();
  return { host: key, apiUrl: trimSlash(setting?.apiUrl ?? `https://${key}`) };
}

/**
 * A remote points to GitLab if its host is gitlab.com, is listed in `gitlabCiView.hosts` (by host or sshAlias),
 * or already has a token. Always defaults to HTTPS; HTTP requires an explicit `apiUrl`.
 */
export function resolveTarget(
  loc: RemoteLocation,
  hosts: readonly HostSetting[],
  tokenHosts: readonly string[],
): GitLabTarget | undefined {
  const setting = findSetting(loc.host, hosts);
  const host = (setting?.host ?? loc.host).toLowerCase();
  if (!setting && host !== GITLAB_COM && !tokenHosts.includes(host)) return undefined;
  const apiUrl = trimSlash(setting?.apiUrl ?? `https://${host}${loc.port ? `:${loc.port}` : ""}`);
  return { host, apiUrl, projectPath: stripRoot(loc.path, apiUrl) };
}

/** Strip the relative URL root (`/gitlab`) from HTTP(S) remote paths. */
function stripRoot(path: string, apiUrl: string): string {
  let root: string;
  try {
    root = new URL(apiUrl).pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return path;
  }
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Try `origin` first, then other remotes in order; use the first remote pointing to GitLab. */
export function resolveRepoTarget(
  remotes: readonly RemoteInfo[],
  hosts: readonly HostSetting[],
  tokenHosts: readonly string[],
): GitLabTarget | undefined {
  const ordered = [...remotes].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
  for (const remote of ordered) {
    const url = remote.fetchUrl ?? remote.pushUrl;
    const loc = url ? parseRemoteUrl(url) : undefined;
    const target = loc ? resolveTarget(loc, hosts, tokenHosts) : undefined;
    if (target) return target;
  }
  return undefined;
}
