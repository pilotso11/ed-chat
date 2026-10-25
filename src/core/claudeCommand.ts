import { existsSync } from "node:fs";
import path from "node:path";
import { HUD_PROMPT } from "./prompt.js";
import type { McpServerInfo } from "./streamJson.js";

export const APPROVAL_SERVER = "ed_chat";
export const APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;

// The version the stream-json fixtures were recorded with.
export const TESTED_CLI_VERSION = "2.1.308";

export interface ResolvedCommand {
  command: string;
  shell: boolean;
}

const isCmdShim = (p: string) => /\.(cmd|bat)$/i.test(p);

export function resolveClaude(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ResolvedCommand | null {
  if (configured)
    return exists(configured) ? { command: configured, shell: isCmdShim(configured) } : null;
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  // The native installer gives claude.exe; an npm install gives a claude.cmd shim, which needs a shell.
  const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
  const join = win ? path.win32.join : path.posix.join;
  for (const name of names) {
    for (const d of dirs) {
      const p = join(d, name);
      if (exists(p)) return { command: p, shell: isCmdShim(p) };
    }
  }
  return null;
}

export function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export function buildClaudeArgs(o: {
  permissionMode: "auto" | "default";
  mcpConfigFile: string;
  extraArgs: string[];
}): string[] {
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
    HUD_PROMPT,
    "--mcp-config",
    o.mcpConfigFile,
    "--permission-prompt-tool",
    APPROVAL_TOOL,
    ...o.extraArgs,
  ];
}

export type Version = [number, number, number];

export function parseCliVersion(out: string): Version | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isOlder(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export type EdMcpState = "ok" | "missing" | "failed" | "needsAuth";

// Servers are still pending at init and their tools are not listed yet, so read the configured list.
// The Claude plugin names its server plugin:<plugin>:ed-mcp.
export function edMcpState(servers: McpServerInfo[]): EdMcpState {
  const s = servers.find((m) => m.name === "ed-mcp" || /^plugin:[^:]+:ed-mcp$/.test(m.name));
  if (!s) return "missing";
  return s.status === "failed" ? "failed" : s.status === "needs-auth" ? "needsAuth" : "ok";
}
