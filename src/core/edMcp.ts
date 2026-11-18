// Where the player set up ed-mcp. ED Chat reads the definition from the assistants' own
// config files, so the player sets it up once, in either CLI, and the activity panel reads
// the same sync folder as the ed-mcp that the assistant runs.
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

export type EdMcpSource = "claudeUser" | "claudeProject";

export interface EdMcpDefinition {
  source: EdMcpSource;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The text of each config file; missing when the file cannot be read. */
export interface AgentConfigs {
  /** ~/.claude.json */
  claudeJson?: string;
}

interface Entry {
  source: EdMcpSource;
  value: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// User scope first, then each project. A project entry is not what runs in ED Chat's own
// folder, but it is the player's definition all the same.
function claudeEntries(claudeJson: string | undefined): Entry[] {
  if (!claudeJson) return [];
  let root: unknown;
  try {
    root = JSON.parse(claudeJson);
  } catch {
    return [];
  }
  if (!isRecord(root)) return [];
  const out: Entry[] = [];
  const add = (servers: unknown, source: EdMcpSource) => {
    if (isRecord(servers) && "ed-mcp" in servers) out.push({ source, value: servers["ed-mcp"] });
  };
  add(root.mcpServers, "claudeUser");
  if (isRecord(root.projects))
    for (const p of Object.values(root.projects))
      if (isRecord(p)) add(p.mcpServers, "claudeProject");
  return out;
}

const entries = (c: AgentConfigs): Entry[] => claudeEntries(c.claudeJson);

function definition(e: Entry): EdMcpDefinition | null {
  if (!isRecord(e.value) || typeof e.value.command !== "string" || !e.value.command) return null;
  const args = Array.isArray(e.value.args) ? e.value.args.filter((a) => typeof a === "string") : [];
  const env: Record<string, string> = {};
  if (isRecord(e.value.env))
    for (const [k, v] of Object.entries(e.value.env)) if (typeof v === "string") env[k] = v;
  return { source: e.source, command: e.value.command, args, env };
}

/** The first ed-mcp that runs as a command, or null when the player has not set one up. */
export function findEdMcp(c: AgentConfigs): EdMcpDefinition | null {
  for (const e of entries(c)) {
    const d = definition(e);
    if (d) return d;
  }
  return null;
}

/**
 * The ED_MCP_SYNC_DIR that the player gave ed-mcp: the panel must read the same activity note
 * and plans. Only that one value is read; the password next to it is not.
 */
export function syncDirOf(c: AgentConfigs): string | null {
  for (const e of entries(c)) {
    const env = isRecord(e.value) ? e.value.env : undefined;
    const dir = isRecord(env) ? env.ED_MCP_SYNC_DIR : undefined;
    if (typeof dir === "string" && dir.trim()) return dir;
  }
  return null;
}

/** Reads each assistant's config file. A file that cannot be read is left out. */
export async function readAgentConfigs(home: string = os.homedir()): Promise<AgentConfigs> {
  const read = (p: string) => readFile(p, "utf8").catch(() => undefined);
  return { claudeJson: await read(path.join(home, ".claude.json")) };
}
