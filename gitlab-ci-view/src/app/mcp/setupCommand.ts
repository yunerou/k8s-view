export type McpClient = "Claude Code" | "Codex";
export type McpShell = "POSIX" | "PowerShell";

export function setupCommand(client: McpClient, shell: McpShell, bridgePath: string): string {
  const quote =
    shell === "PowerShell"
      ? (value: string) => `'${value.replaceAll("'", "''")}'`
      : (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `${client === "Claude Code" ? "claude mcp add --transport stdio --scope user" : "codex mcp add"} gitlab-ci -- node ${quote(bridgePath)}`;
}
