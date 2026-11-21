import type { AgentInfo } from "./backend.js";
import { isOlder, parseCliVersion } from "./cli.js";
import type { EdMcpState } from "./edMcp.js";

// The strip's notices that main sets. A command in backticks is copied when the player clicks
// the notice (see noticeCommand in view.ts).

export const SCOPE_GAME = "ⓘ hotkeys work while Elite is in front";
export const COMMAND_COPIED = "📋 copied; paste it in a terminal";
export const FULLSCREEN = "⚠ Elite is in fullscreen; switch to Borderless to see the overlay";
export const REFOCUS = "⚠ click the game to refocus";
export const IN_DANGER = "⛔ in danger: chat blocked";
export const NO_AUTO = "⚠ auto mode unavailable, using manual approvals";
export const RESUMED = "↺ resumed your last conversation";
export const RESUME_FAILED = "ⓘ could not resume the last conversation; started a new one";
export const PLAYER_ONLY_WAITING = "⚠ settings.json: a change waits for your answer";
export const busyText = (a: AgentInfo) => `⚠ ${a.name} is busy`;
export const gaveUpText = (a: AgentInfo) => `⚠ ${a.name} keeps stopping`;

/** What the strip says about ed-mcp, from how the assistant reported it; null when it runs. */
export function edMcpNotice(
  state: EdMcpState,
  agent: AgentInfo,
  setupCommand: string,
): string | null {
  switch (state) {
    case "missing":
      return `⚠ ed-mcp not connected; click to copy \`${setupCommand}\``;
    case "failed":
      return `⚠ ed-mcp failed to start; run \`${agent.mcpListCommand}\``;
    case "needsAuth":
      return `⚠ ed-mcp needs authentication; run \`${agent.mcpListCommand}\``;
    default:
      return null;
  }
}

/** Auto mode was asked for, and the assistant started in another mode. */
export function modeNotice(wanted: string, started: string | undefined | null): string | null {
  return wanted === "auto" && started && started !== "auto" ? NO_AUTO : null;
}

/** The CLI's --version output, against the version ED Chat was tested with. */
export function versionNotice(
  output: string | null,
  testedText: string,
  agent: AgentInfo,
): { version: string | null; notice: string | null } {
  const v = output === null ? null : parseCliVersion(output);
  const tested = parseCliVersion(testedText);
  return {
    version: v ? v.join(".") : null,
    notice:
      v && tested && isOlder(v, tested)
        ? `⚠ ${agent.cli} ${v.join(".")} is older than ${testedText}; run \`${agent.updateCommand}\``
        : null,
  };
}

/** The strip gives the count; the tray menu lists each key. */
export function hotkeysNotice(failed: string[]): string | null {
  if (!failed.length) return null;
  return `⚠ ${failed.length} hotkey${failed.length > 1 ? "s" : ""} not working; see tray menu`;
}

/** Shown when the hotkeys are off because Elite is not in front. */
export function scopeNotice(wanted: boolean): string | null {
  return wanted ? null : SCOPE_GAME;
}
