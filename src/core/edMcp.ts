// Where the player set up ed-mcp. ED Chat reads the definition from the assistants' own
// config files, so the player sets it up once, in either CLI, and the activity panel reads
// the same sync folder as the ed-mcp that the assistant runs.
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import type { AgentId, McpServerInfo } from "./backend.js";
import { isCmdShim } from "./cli.js";

/**
 * Where an entry comes from. claudePlugin is the ed-mcp plugin for Claude Code: it runs from the
 * plugin's own folder, so only its sync folder is read from it.
 */
export type EdMcpSource = "claudeUser" | "claudeProject" | "codex" | "claudePlugin";

export interface EdMcpDefinition {
  source: EdMcpSource;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The text of each config file; missing when the file is not there. A file that is there but
 * cannot be read is listed in unreadable, and may hold the agent's own ed-mcp.
 */
export interface AgentConfigs {
  /** ~/.claude.json */
  claudeJson?: string;
  /** ~/.claude/settings.json, for the plugin's options. */
  claudeSettings?: string;
  /** ~/.codex/config.toml */
  codexToml?: string;
  /** Files that are there but could not be read (not "not found"). */
  unreadable?: ConfigFile[];
}

export type ConfigFile = "claudeJson" | "claudeSettings" | "codexToml";

interface Entry {
  source: EdMcpSource;
  value: unknown;
  /** The folder of a claudeProject entry. */
  project?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

// User scope first, then each project. Callers that know ED Chat's folder move its project
// entry to the front (entriesFor), as Claude ranks it; another project's entry does not run in
// ED Chat's folder, but it is the player's definition all the same.
function claudeEntries(claudeJson: string | undefined): Entry[] {
  const root = parseJson(claudeJson);
  if (!root) return [];
  const out: Entry[] = [];
  if (isRecord(root.mcpServers) && "ed-mcp" in root.mcpServers)
    out.push({ source: "claudeUser", value: root.mcpServers["ed-mcp"] });
  if (isRecord(root.projects))
    for (const [project, p] of Object.entries(root.projects))
      if (isRecord(p) && isRecord(p.mcpServers) && "ed-mcp" in p.mcpServers)
        out.push({ source: "claudeProject", value: p.mcpServers["ed-mcp"], project });
  return out;
}

function parseCodexToml(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

function codexEntries(codexToml: string | undefined): Entry[] {
  const root = parseCodexToml(codexToml);
  if (!isRecord(root) || !isRecord(root.mcp_servers) || !("ed-mcp" in root.mcp_servers)) return [];
  return [{ source: "codex", value: root.mcp_servers["ed-mcp"] }];
}

// The plugin that Claude Code runs: enabled, and either the ed-mcp plugin or one with its sync
// option. Its options are in pluginConfigs; the password is in Claude's secret store, not here.
const PLUGIN_NAME = "elite-dangerous-mcp";
function pluginEntries(claudeSettings: string | undefined): Entry[] {
  const root = parseJson(claudeSettings);
  if (!root || !isRecord(root.enabledPlugins)) return [];
  const configs = isRecord(root.pluginConfigs) ? root.pluginConfigs : {};
  const out: Entry[] = [];
  for (const [id, on] of Object.entries(root.enabledPlugins)) {
    if (on !== true) continue;
    const config = configs[id];
    const options = isRecord(config) && isRecord(config.options) ? config.options : {};
    if (id.split("@")[0] !== PLUGIN_NAME && !("ed_mcp_sync_dir" in options)) continue;
    out.push({
      source: "claudePlugin",
      value: { env: { ED_MCP_SYNC_DIR: options.ed_mcp_sync_dir } },
    });
  }
  return out;
}

const entries = (c: AgentConfigs): Entry[] => [
  ...claudeEntries(c.claudeJson),
  ...codexEntries(c.codexToml),
  ...pluginEntries(c.claudeSettings),
];

// An entry that runs a command, with the fields ED Chat can pass on. Codex's enabled = false
// means the player turned it off.
function definition(e: Entry): EdMcpDefinition | null {
  if (e.source === "claudePlugin" || !isRecord(e.value)) return null;
  if (typeof e.value.command !== "string" || !e.value.command || e.value.enabled === false)
    return null;
  const args = Array.isArray(e.value.args) ? e.value.args.filter((a) => typeof a === "string") : [];
  const env: Record<string, string> = {};
  if (isRecord(e.value.env))
    for (const [k, v] of Object.entries(e.value.env)) if (typeof v === "string") env[k] = v;
  return { source: e.source, command: e.value.command, args, env };
}

const firstDefinition = (all: Entry[]): EdMcpDefinition | null => {
  for (const e of all) {
    const d = definition(e);
    if (d) return d;
  }
  return null;
};

/**
 * The first ed-mcp that runs as a command, in this order: Claude's project entry for ED Chat's
 * folder (when workspace is given), Claude's user scope, Claude's other projects, Codex's
 * config.toml. Null when none runs as a command: the plugin, an http server or one switched
 * off in Codex can still be set up, so this is not "is ed-mcp set up anywhere".
 */
export const findEdMcp = (c: AgentConfigs, workspace: string): EdMcpDefinition | null =>
  firstDefinition(entriesFor(c, workspace));

function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

const isHere = (e: Entry, workspace?: string): boolean =>
  e.source === "claudeProject" && !!workspace && !!e.project && samePath(e.project, workspace);

// All entries, with Claude's project entry for ED Chat's folder first, as Claude ranks it: the
// definition ED Chat copies is then the one Claude runs.
function entriesFor(c: AgentConfigs, workspace?: string): Entry[] {
  const all = entries(c);
  return [...all.filter((e) => isHere(e, workspace)), ...all.filter((e) => !isHere(e, workspace))];
}

// The agent's own ed-mcp, which always wins, so ed-mcp never runs twice. Claude's counts when it
// is the project for ED Chat's own folder (which Claude prefers to user scope, as it does every
// project entry), user scope, or the plugin. Codex's counts when config.toml names one, even
// one switched off.
function ownEntry(agent: AgentId, all: Entry[], workspace?: string): Entry | null {
  if (agent === "codex") return all.find((e) => e.source === "codex") ?? null;
  return (
    all.find((e) => isHere(e, workspace)) ??
    all.find((e) => e.source === "claudeUser") ??
    all.find((e) => e.source === "claudePlugin") ??
    null
  );
}

/**
 * The ed-mcp that ED Chat gives the agent: the player's definition from another place, when the
 * agent's own config has none. Null when the agent has its own, or there is none at all.
 */
export function edMcpToAdd(
  agent: AgentId,
  c: AgentConfigs,
  workspace: string,
): EdMcpDefinition | null {
  if (ownConfigUnreadable(agent, c, workspace)) return null;
  const all = entriesFor(c, workspace);
  return ownEntry(agent, all, workspace) ? null : firstDefinition(all);
}

/**
 * A definition that a CLI can start on Windows. npx, npm and other .cmd shims cannot be
 * started directly, only through cmd /c, which `codex mcp add` leaves to the player.
 */
export function startableOn(
  d: EdMcpDefinition,
  platform: NodeJS.Platform = process.platform,
): EdMcpDefinition {
  if (platform !== "win32") return d;
  const name = path.win32.basename(d.command).toLowerCase();
  const shim = isCmdShim(name) || /^(npx|npm|pnpm|pnpx|yarn|bunx)$/.test(name);
  return shim ? { ...d, command: "cmd", args: ["/c", d.command, ...d.args] } : d;
}

const syncDir = (dir: unknown): string | null =>
  typeof dir === "string" && dir.trim() ? dir : null;

function envSyncDir(e: Entry): string | null {
  const env = isRecord(e.value) ? e.value.env : undefined;
  return syncDir(isRecord(env) ? env.ED_MCP_SYNC_DIR : undefined);
}

/**
 * The ED_MCP_SYNC_DIR that the player gave ed-mcp: the panel must read the same activity note
 * and plans. It comes from the ed-mcp that the agent runs (its own, or the one ED Chat adds), so
 * a sync folder in another entry cannot point the panel away from where ed-mcp writes. With
 * none that runs, the first entry that names one. Only that one value is used here; the
 * password next to it is not (edMcpToAdd passes the whole env on to the agent).
 */
export function syncDirOf(
  c: AgentConfigs,
  agent: AgentId = "claude",
  workspace?: string,
): string | null {
  // The ed-mcp that runs may be in the file that cannot be read: no folder is better than
  // another entry's.
  if (ownConfigUnreadable(agent, c, workspace)) return null;
  const all = entriesFor(c, workspace);
  const own = ownEntry(agent, all, workspace);
  if (own && (own.source === "claudePlugin" || definition(own))) return envSyncDir(own);
  if (!own) {
    const added = firstDefinition(all);
    if (added) return syncDir(added.env.ED_MCP_SYNC_DIR);
  }
  for (const e of all) {
    const dir = envSyncDir(e);
    if (dir) return dir;
  }
  return null;
}

/** Config files that are there but cannot be read or parsed, for the log. */
export function configProblems(c: AgentConfigs): ConfigFile[] {
  const out = new Set<ConfigFile>(c.unreadable ?? []);
  // An empty JSON file is one being rewritten; an empty config.toml is a valid empty config.
  if (c.claudeJson !== undefined && !parseJson(c.claudeJson)) out.add("claudeJson");
  if (c.claudeSettings !== undefined && !parseJson(c.claudeSettings)) out.add("claudeSettings");
  if (c.codexToml !== undefined && !isRecord(parseCodexToml(c.codexToml))) out.add("codexToml");
  return [...out];
}

/**
 * The agent's own config file is there but cannot be read or parsed (mid-write by a running
 * CLI, say). It may hold the agent's own ed-mcp, so ED Chat adds none: ed-mcp could run twice.
 */
export function ownConfigUnreadable(agent: AgentId, c: AgentConfigs, workspace?: string): boolean {
  if (agent === "codex") return configProblems(c).includes("codexToml");
  if (configProblems(c).includes("claudeJson")) return true;
  // Claude's settings.json holds only the plugin. One that does not parse cannot load the
  // plugin either (and stays broken until the player fixes it), so only a read error counts,
  // and only when the plugin could be Claude's own ed-mcp: its user scope and the project for
  // ED Chat's folder rank above it.
  if (!c.unreadable?.includes("claudeSettings")) return false;
  return !claudeEntries(c.claudeJson).some(
    (e) => e.source === "claudeUser" || isHere(e, workspace),
  );
}

/**
 * Reads each assistant's config file. A file that is not there is left out; one that is there
 * but cannot be read is listed in unreadable. CLAUDE_CONFIG_DIR and CODEX_HOME move the files,
 * as they do for the CLIs.
 */
export async function readAgentConfigs(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentConfigs> {
  const unreadable: ConfigFile[] = [];
  const read = (p: string, f: ConfigFile) =>
    readFile(p, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") unreadable.push(f);
      return undefined;
    });
  const claudeDir = env.CLAUDE_CONFIG_DIR || null;
  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  const [claudeJson, claudeSettings, codexToml] = await Promise.all([
    read(path.join(claudeDir ?? home, ".claude.json"), "claudeJson"),
    read(path.join(claudeDir ?? path.join(home, ".claude"), "settings.json"), "claudeSettings"),
    read(path.join(codexDir, "config.toml"), "codexToml"),
  ]);
  return unreadable.length
    ? { claudeJson, claudeSettings, codexToml, unreadable }
    : { claudeJson, claudeSettings, codexToml };
}

export type EdMcpState = "ok" | "missing" | "failed" | "needsAuth";

// Servers are still pending at init and their tools are not listed yet, so the configured list
// is read. Each backend gives its statuses in these words (pending, connected, failed,
// needs-auth). Claude's plugin names its server plugin:<plugin>:ed-mcp, next to an ed-mcp from
// claude mcp add; one that works is enough, so a failed copy must not hide a working one.
export function edMcpState(servers: McpServerInfo[]): EdMcpState {
  const found = servers.filter((m) => m.name === "ed-mcp" || /^plugin:[^:]+:ed-mcp$/.test(m.name));
  if (!found.length) return "missing";
  if (found.some((m) => m.status !== "failed" && m.status !== "needs-auth")) return "ok";
  return found.some((m) => m.status === "needs-auth") ? "needsAuth" : "failed";
}
