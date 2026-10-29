/**
 * Small shell wrapper for processes in VS Code terminals. Commands and argv are positional (`"$0" "$@"`), so
 * POSIX needs no quoting; Windows uses PowerShell with single-quoted strings.
 */
export interface ShellLaunch {
  readonly shellPath: string;
  readonly shellArgs: string[];
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Run a command and keep the terminal open (print exit code, wait for Enter) to read results, e.g. `kubectl get` snippets. */
export function holdOpenShell(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ShellLaunch {
  if (platform === "win32") {
    const script = [
      `& ${[command, ...args].map(psQuote).join(" ")}`,
      "$code = $LASTEXITCODE",
      "Write-Host ''",
      'Read-Host "[exit code $code] Press Enter to close" | Out-Null',
    ].join("; ");
    return { shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoProfile", "-Command", script] };
  }
  // Ctrl+C stops the command (logs -f), but not the shell: traps reset to defaults in the child process.
  const script = [
    "trap : INT",
    '"$0" "$@"',
    "code=$?",
    'printf "\\n\\033[2m[exit code %d] Press Enter to close\\033[0m" "$code"',
    "read _",
  ].join("\n");
  return { shellPath: "/bin/sh", shellArgs: ["-c", script, command, ...args] };
}

/**
 * Run an exec auth plugin: stdout (credentials) → `out` file; stdin/stderr stay in the terminal for interaction.
 * Close the terminal automatically on success; keep it open on failure to read errors.
 */
export function signInShell(
  out: string,
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ShellLaunch {
  if (platform === "win32") {
    const script = [
      `& ${[command, ...args].map(psQuote).join(" ")} | Set-Content -Encoding UTF8 -Path ${psQuote(out)}`,
      "$code = $LASTEXITCODE",
      `if ($code -ne 0) { Write-Host ''; Read-Host "Sign-in failed (exit $code). Press Enter to close" | Out-Null }`,
      "exit $code",
    ].join("; ");
    return { shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoProfile", "-Command", script] };
  }
  const script = [
    'out=$1; shift; "$@" > "$out"; code=$?',
    'if [ "$code" -ne 0 ]; then printf "\\nSign-in failed (exit %d). Press Enter to close." "$code"; read _; fi',
    'exit "$code"',
  ].join("\n");
  return { shellPath: "/bin/sh", shellArgs: ["-c", script, "k8s-view-sign-in", out, command, ...args] };
}
