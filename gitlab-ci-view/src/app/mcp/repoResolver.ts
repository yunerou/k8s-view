import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoRef } from "../RepoRegistry";

export function containsPath(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function rootPath(repo: RepoRef): string {
  return fileURLToPath(repo.id);
}

export function resolveRepo(repos: readonly RepoRef[], options: { repo?: string; cwd?: string }): RepoRef {
  const available = repos.map((r) => `${r.name} (${r.host}/${r.projectPath})`).join(", ") || "none";
  if (options.repo !== undefined) {
    const name = options.repo.toLowerCase();
    const matches = repos.filter((r) => r.name.toLowerCase() === name || r.projectPath.toLowerCase() === name);
    if (matches.length === 1) return matches[0]!;
    throw new Error(`${matches.length ? "Ambiguous" : "Unknown"} repo '${options.repo}'. Available: ${available}`);
  }
  if (options.cwd) {
    const matches = repos.filter((r) => containsPath(rootPath(r), options.cwd!));
    const longest = Math.max(...matches.map((r) => rootPath(r).length));
    const best = matches.filter((r) => rootPath(r).length === longest);
    if (best.length === 1) return best[0]!;
    if (best.length > 1) throw new Error(`Ambiguous repo; pass repo. Available: ${available}`);
  }
  if (repos.length === 1) return repos[0]!;
  throw new Error(`Several GitLab repos are open or none is available; pass repo. Available: ${available}`);
}
