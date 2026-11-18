import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServerInfo } from "../../backend.js";
import { resolveCli, type CliLookup, type ResolvedCommand } from "../../cli.js";
import { HUD_PROMPT, settingsPrompt } from "../../prompt.js";

export const APPROVAL_SERVER = "ed_chat";
export const APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;

// The version the stream-json fixtures were recorded with.
export const TESTED_CLI_VERSION = "2.1.308";

const win32 = path.win32;

/**
 * claude.exe from the native installer, or the claude.cmd shim from npm, which needs a shell.
 * Both installers can leave PATH alone, so their default folders are tried after PATH.
 */
export function claudeLookup(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliLookup {
  const win = platform === "win32";
  const defaultPaths: string[] = [];
  if (win && env.USERPROFILE)
    defaultPaths.push(win32.join(env.USERPROFILE, ".local", "bin", "claude.exe"));
  if (win && env.APPDATA) defaultPaths.push(win32.join(env.APPDATA, "npm", "claude.cmd"));
  return { names: win ? ["claude.exe", "claude.cmd"] : ["claude"], defaultPaths };
}

export function resolveClaude(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ResolvedCommand | null {
  return resolveCli(claudeLookup(env, platform), configured, env, platform, exists);
}

export function buildClaudeArgs(o: {
  permissionMode: "auto" | "default";
  mcpConfigFile: string;
  extraArgs: string[];
  /** ED Chat's settings.json, which the player can ask Claude to show or change. */
  settingsFile?: string;
}): string[] {
  const prompt = o.settingsFile ? `${HUD_PROMPT} ${settingsPrompt(o.settingsFile)}` : HUD_PROMPT;
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    o.permissionMode,
    "--append-system-prompt",
    prompt,
    "--mcp-config",
    o.mcpConfigFile,
    "--permission-prompt-tool",
    APPROVAL_TOOL,
    ...o.extraArgs,
  ];
}

export type EdMcpState = "ok" | "missing" | "failed" | "needsAuth";

// Servers are still pending at init and their tools are not listed yet, so read the configured list.
// The Claude plugin names its server plugin:<plugin>:ed-mcp. A player can have both, and one
// that works is enough: a failed plugin must not hide a working claude mcp add server.
export function edMcpState(servers: McpServerInfo[]): EdMcpState {
  const found = servers.filter((m) => m.name === "ed-mcp" || /^plugin:[^:]+:ed-mcp$/.test(m.name));
  if (!found.length) return "missing";
  if (found.some((m) => m.status !== "failed" && m.status !== "needs-auth")) return "ok";
  return found.some((m) => m.status === "needs-auth") ? "needsAuth" : "failed";
}
