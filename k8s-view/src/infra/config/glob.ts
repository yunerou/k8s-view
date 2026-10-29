/**
 * Simple globs for `k8sView.configFiles`: leading `~`, with `*` and `?` wildcards only in filenames
 * (sufficient for patterns such as `~/.config/k8s-view/*.json`).
 */
export function splitGlob(pattern: string, home: string): { dir: string; matches(name: string): boolean } {
  const expanded = pattern.replace(/^~(?=$|[\\/])/, home);
  const cut = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
  const dir = cut < 0 ? "." : expanded.slice(0, cut) || expanded.slice(0, 1);
  const file = expanded.slice(cut + 1);
  const regex = new RegExp(
    `^${file
      .split("")
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );
  return { dir, matches: (name) => regex.test(name) };
}
