import { existsSync } from "node:fs";
import path from "node:path";
import { resolveCli, type CliLookup, type ResolvedCommand } from "../../cli.js";
import { HUD_PROMPT, settingsPrompt } from "../../prompt.js";

// The version the protocol was probed with (spec, "Step 0 results").
export const TESTED_CODEX_VERSION = "0.170.0";

const win32 = path.win32;

/**
 * codex.exe or the npm codex.cmd shim on PATH, then the standalone install, which does not
 * always add itself to PATH (current links to the newest release), then the npm shim's folder.
 */
export function codexLookup(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliLookup {
  const win = platform === "win32";
  const defaultPaths: string[] = [];
  if (win && env.USERPROFILE)
    defaultPaths.push(
      win32.join(
        env.USERPROFILE,
        ".codex",
        "packages",
        "standalone",
        "current",
        "bin",
        "codex.exe",
      ),
    );
  if (win && env.APPDATA) defaultPaths.push(win32.join(env.APPDATA, "npm", "codex.cmd"));
  return { names: win ? ["codex.exe", "codex.cmd"] : ["codex"], defaultPaths };
}

export function resolveCodex(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ResolvedCommand | null {
  return resolveCli(codexLookup(env, platform), configured, env, platform, exists);
}

export function buildCodexArgs(o: { extraArgs: string[] }): string[] {
  return ["app-server", ...o.extraArgs];
}

/** The ed-mcp server as Codex's config takes it. */
export interface CodexMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What thread/start and thread/resume carry. The same on both, so a resume keeps the setup. */
export interface ThreadSettings {
  /** Absolute: a relative cwd makes MCP servers fail to start. */
  cwd: string;
  approvalPolicy: "on-request" | "untrusted";
  sandbox: "workspace-write";
  developerInstructions: string;
  /** The model; absent, Codex's config.toml decides. */
  model?: string;
  /** Config overrides, for example ed-mcp when Codex's own config lacks it. */
  config?: Record<string, unknown>;
}

/**
 * auto lets Codex decide inside the sandbox; default asks before anything that is not known to
 * be safe. Both keep the sandbox to workspace-write, limited to ED Chat's data folder, so shell
 * commands and file changes outside it come to the approval card.
 */
export function codexThreadSettings(o: {
  permissionMode: "auto" | "default";
  /** null: the model in Codex's config.toml. */
  model?: string | null;
  cwd: string;
  /** ED Chat's settings.json, which the player can ask Codex to show or change. */
  settingsFile?: string;
  /** Passed only when Codex's config.toml has no ed-mcp of its own. */
  edMcp?: CodexMcpServer | null;
}): ThreadSettings {
  if (!path.isAbsolute(o.cwd)) throw new Error(`cwd must be absolute: ${o.cwd}`);
  const prompt = o.settingsFile ? `${HUD_PROMPT} ${settingsPrompt(o.settingsFile)}` : HUD_PROMPT;
  const s: ThreadSettings = {
    cwd: o.cwd,
    approvalPolicy: o.permissionMode === "auto" ? "on-request" : "untrusted",
    sandbox: "workspace-write",
    developerInstructions: prompt,
  };
  if (o.model) s.model = o.model;
  const config: Record<string, unknown> = {};
  // In the request body, not as -c arguments: the env can hold ED_MCP_SYNC_PASSWORD, and
  // command lines are visible to other processes.
  if (o.edMcp) config.mcp_servers = { "ed-mcp": o.edMcp };
  // In auto mode Codex may change settings.json without a card, as Claude does: its folder is
  // writable in the sandbox. ED Chat still asks the player about player-only settings.
  if (o.permissionMode === "auto" && o.settingsFile)
    config.sandbox_workspace_write = { writable_roots: [path.dirname(o.settingsFile)] };
  if (Object.keys(config).length) s.config = config;
  return s;
}

/** The permission mode that a thread's approval policy amounts to, for the ready event. */
export function permissionModeOf(approvalPolicy: unknown): string | null {
  if (approvalPolicy === "on-request") return "auto";
  if (approvalPolicy === "untrusted") return "default";
  return typeof approvalPolicy === "string" ? approvalPolicy : null;
}
