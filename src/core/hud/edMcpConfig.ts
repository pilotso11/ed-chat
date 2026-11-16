/**
 * The ED_MCP_SYNC_DIR that Claude Code passes to ed-mcp, from the text of ~/.claude.json. The
 * panel must read the same activity note and plans as ed-mcp. Only that one value is read;
 * the password next to it is not.
 */
export function edMcpSyncDir(claudeJson: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(claudeJson);
  } catch {
    return null;
  }
  const fromServers = (servers: unknown): string | null => {
    if (!servers || typeof servers !== "object") return null;
    const ed = (servers as Record<string, unknown>)["ed-mcp"];
    const env = (ed as { env?: unknown } | undefined)?.env;
    const dir = (env as Record<string, unknown> | undefined)?.ED_MCP_SYNC_DIR;
    return typeof dir === "string" && dir.trim() ? dir : null;
  };
  const root = j as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
  const user = fromServers(root?.mcpServers);
  if (user) return user;
  for (const p of Object.values(root?.projects ?? {})) {
    const dir = fromServers(p?.mcpServers);
    if (dir) return dir;
  }
  return null;
}
