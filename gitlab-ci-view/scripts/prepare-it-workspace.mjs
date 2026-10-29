// Create a workspace with two Git repositories (one GitLab, one GitHub) for integration tests; no network required.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", ".tmp", "it-workspace");
rmSync(root, { recursive: true, force: true });
for (const [name, remote] of [
  ["demo", "git@gitlab.com:group/sub/demo.git"],
  ["other", "https://github.com/someone/other.git"],
]) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
}
writeFileSync(join(root, "it.code-workspace"), JSON.stringify({ folders: [{ path: "demo" }, { path: "other" }] }));
