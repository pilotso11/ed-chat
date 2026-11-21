import path from "node:path";
import type { AgentId } from "./backend.js";
import { buildClaudeArgs } from "./backends/claude/command.js";
import { buildCodexArgs } from "./backends/codex/command.js";
import type { Settings } from "./settings.js";

// Decisions main makes about the assistant and the game files, apart from running them.

/** ED Chat's own commands, typed in the chat; they never reach the assistant. */
export const LOCAL_COMMANDS = ["/new", "/version", "/claude", "/codex"] as const;
export type LocalCommand = (typeof LOCAL_COMMANDS)[number];

export function localCommand(text: string): LocalCommand | null {
  return (LOCAL_COMMANDS as readonly string[]).includes(text) ? (text as LocalCommand) : null;
}

/** The assistant's CLI arguments from the settings. */
export function agentArgs(
  id: AgentId,
  s: Settings,
  files: { mcpConfigFile: string; settingsFile: string },
): string[] {
  return id === "claude"
    ? buildClaudeArgs({
        permissionMode: s.claude.permissionMode,
        model: s.claude.model,
        mcpConfigFile: files.mcpConfigFile,
        extraArgs: s.claude.extraArgs,
        settingsFile: files.settingsFile,
      })
    : buildCodexArgs({ extraArgs: s.codex.extraArgs });
}

/**
 * Why an assistant cannot start at all: ED Chat's data folder is not writable, or, for Claude,
 * which asks for approval through it, the approval server did not start.
 */
export function blockedFor(
  id: AgentId,
  problems: { data: string | null; approval: string | null },
): string | null {
  return problems.data ?? (id === "claude" ? problems.approval : null);
}

/**
 * First run, before any conversation: with only Codex installed, Codex is the assistant; with
 * both, Claude stays and the player hears how to switch, once. A settings.json that names the
 * agent has chosen already; a broken one waits.
 */
export function firstRunChoice(c: {
  firstRun: boolean;
  settingsText: string;
  settingsBroken: boolean;
  /** Looked up only when the choice depends on them: a lookup searches PATH. */
  claudeFound: () => boolean;
  codexFound: () => boolean;
  hintShown: boolean;
}): "codex" | "hint" | null {
  if (!c.firstRun || c.settingsBroken) return null;
  try {
    const raw = JSON.parse(c.settingsText) as Record<string, unknown>;
    if ("agent" in raw) return null;
  } catch {
    return null;
  }
  if (!c.codexFound()) return null;
  if (!c.claudeFound()) return "codex";
  return c.hintShown ? null : "hint";
}

/** Where Elite writes its journal, unless the settings say otherwise. */
export function journalDir(s: Settings, home: string): string {
  return s.journalDir ?? path.join(home, "Saved Games", "Frontier Developments", "Elite Dangerous");
}

/** Elite's display settings, which say whether it runs in fullscreen. */
export function displaySettingsFile(localAppData: string | undefined, home: string): string {
  return path.join(
    localAppData ?? path.join(home, "AppData", "Local"),
    "Frontier Developments",
    "Elite Dangerous",
    "Options",
    "Graphics",
    "DisplaySettings.xml",
  );
}

export interface SettingsChange {
  /** The panel's data comes from another place: open the feed again. */
  reopenFeed: boolean;
  /** Another assistant was chosen. */
  switchAgent: boolean;
  /** The running assistant's own settings changed (and it was not switched). */
  agentSettings: boolean;
  /** Status.json is in another folder. */
  journal: boolean;
}

/** What a new settings.json changes for the running app. */
export function settingsChange(
  old: Settings,
  next: Settings,
  agentId: AgentId,
  home: string,
): SettingsChange {
  const journal = journalDir(old, home) !== journalDir(next, home);
  const switchAgent = old.agent !== next.agent;
  return {
    reopenFeed:
      journal ||
      old.hud.edMcpDataDir !== next.hud.edMcpDataDir ||
      old.hud.spansh !== next.hud.spansh,
    switchAgent,
    agentSettings: !switchAgent && JSON.stringify(old[agentId]) !== JSON.stringify(next[agentId]),
    journal,
  };
}
