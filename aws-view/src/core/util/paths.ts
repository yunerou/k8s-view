/** `~` and `~/…` → home directory (other users' `~name` are left alone). */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
