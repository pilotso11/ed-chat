import type { Foreground } from "./focus.js";
import type { Settings } from "./settings.js";

export const MAX_HEIGHT = 2000;
export const STDERR_CHARS = 160;

export function hotkeysWanted(
  scope: Settings["hotkeys"]["scope"],
  f: Foreground | null | undefined,
): boolean {
  return scope === "always" || Boolean(f?.isGame || f?.isOverlay);
}

export function textArg(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function chipArg(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

export function boolArg(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function answerArg(v: unknown): "approve" | "deny" | "alwaysAllow" | null {
  return v === "approve" || v === "deny" || v === "alwaysAllow" ? v : null;
}

export function heightArg(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(v, MAX_HEIGHT);
}

const label = (v: unknown): string =>
  typeof v === "string" ? v.slice(0, 40) : v === undefined ? "-" : typeof v;

// Unknown events can carry message text, so only their type is logged. Null means drop silently.
// Codex notifications that come every turn and that ED Chat does not need.
const CODEX_ROUTINE = [
  "thread/tokenUsage",
  "account/rateLimits",
  "thread/started",
  "turn/started",
  "item/reasoning",
  "turn/diff",
  "turn/plan",
  // Streamed output, in many small pieces.
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
];

export function describeUnknown(raw: unknown): string | null {
  if (typeof raw === "string") return `non-JSON line (${raw.length} chars)`;
  if (typeof raw !== "object" || raw === null) return `non-object ${typeof raw}`;
  const r = raw as Record<string, unknown>;
  if (r.type === "system" && typeof r.subtype === "string" && r.subtype.startsWith("hook_"))
    return null;
  // Codex: a notification that ED Chat does not use. Its params can quote the chat, so only
  // the method is logged, and the routine ones not at all.
  if (typeof r.method === "string")
    return CODEX_ROUTINE.some((m) => r.method === m || (r.method as string).startsWith(m + "/"))
      ? null
      : `method=${label(r.method)}`;
  return `type=${label(r.type)} subtype=${label(r.subtype)}`;
}

export function capLines(lines: string[], max = STDERR_CHARS): string[] {
  return lines.map((l) => (l.length > max ? `${l.slice(0, max)}…` : l));
}
