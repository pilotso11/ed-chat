import type { JournalEvent } from "ed-mcp/journal";
import type { HudModeId } from "../settings.js";

/** Journal events the mode rules and panels read, besides the ones ed-mcp keeps. */
export const HUD_EVENTS = [
  "ApproachBody",
  "Touchdown",
  "Liftoff",
  "LeaveBody",
  "Disembark",
  "SellExplorationData",
  "MultiSellExplorationData",
  "NavRoute",
  "NavRouteClear",
] as const;

export interface Choice {
  mode: HudModeId | "off";
  /** Epoch ms. The newest choice wins. */
  at: number;
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const objs = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x): x is Obj => typeof x === "object" && x !== null) : [];

const isMassacre = (e: JournalEvent) =>
  typeof e.Name === "string" && /massacre/i.test(e.Name) && typeof e.KillCount === "number";

const bioCount = (e: JournalEvent) =>
  objs(e.Signals)
    .filter((s) => typeof s.Type === "string" && s.Type.endsWith("SignalType_Biological;"))
    .reduce((n, s) => n + (num(s.Count) ?? 0), 0);

/** Jumps with no scan that end exploration mode. */
export const LAPSE_JUMPS = 5;

/**
 * The mode the journal asks for, and when it asked. Massacre missions turn on massacre mode;
 * a discovery scan or a detailed scan turns on exploration; a body with biological signals, or
 * a bio sample, turns on exobiology. A jump alone starts nothing, and LAPSE_JUMPS jumps with no
 * scan end exploration.
 * `massacreActive` is whether a massacre mission is still open now (from ed-mcp's massacre()).
 */
export function journalMode(events: JournalEvent[], massacreActive: boolean): Choice | null {
  const bio = new Set<string>();
  let mode: HudModeId | null = null;
  let at = 0;
  // The mode before massacre, to go back to when the stack is handed in.
  let before: { mode: HudModeId | null; at: number } = { mode: null, at: 0 };
  const set = (m: HudModeId, e: JournalEvent) => {
    if (m === "massacre" && mode !== "massacre") before = { mode, at };
    if (m === "exploration" || m === "exobiology") jumps = 0;
    mode = m;
    at = Date.parse(e.timestamp) || at;
  };
  // Jumps since the last exploration event: a trip home ends exploration mode.
  let jumps = 0;
  for (const e of events) {
    const key = `${num(e.SystemAddress)}|${num(e.BodyID)}`;
    switch (e.event) {
      case "FSDJump":
        jumps++;
        if (mode === "exploration" && jumps >= LAPSE_JUMPS) mode = null;
        break;
      case "MissionAccepted":
        if (isMassacre(e)) set("massacre", e);
        break;
      case "FSSDiscoveryScan":
        if (mode !== "massacre") set("exploration", e);
        break;
      case "Scan":
        if (e.ScanType === "Detailed" && mode !== "massacre") set("exploration", e);
        break;
      case "FSSBodySignals":
      case "SAASignalsFound":
        if (bioCount(e) > 0) bio.add(key);
        break;
      case "ApproachBody":
      case "Touchdown":
        if (bio.has(key) && mode !== "massacre") set("exobiology", e);
        break;
      case "ScanOrganic":
        if (mode !== "massacre") set("exobiology", e);
        break;
      case "LeaveBody":
        if (mode === "exobiology") set("exploration", e);
        break;
    }
  }
  if (mode === "massacre" && !massacreActive) {
    mode = before.mode;
    at = before.at;
  }
  return mode ? { mode, at } : null;
}

/** The newest of the journal, the activity note and the hotkey; null when nothing chose. */
export function pickMode(...choices: (Choice | null | undefined)[]): Choice | null {
  let best: Choice | null = null;
  for (const c of choices) if (c && (!best || c.at >= best.at)) best = c;
  return best;
}

/** The hotkey's next mode: auto, then each enabled mode, then off, then auto again. */
export function cycleMode(
  current: HudModeId | "off" | "auto",
  enabled: HudModeId[],
): HudModeId | "off" | "auto" {
  const order: (HudModeId | "off" | "auto")[] = ["auto", ...enabled, "off"];
  const i = order.indexOf(current);
  return order[(i + 1) % order.length]!;
}

/** The activity note's kind as a panel mode, if it is one. */
export function noteMode(kind: string | undefined): HudModeId | null {
  switch (kind) {
    case "massacre":
    case "exploration":
    case "exobiology":
      return kind;
    default:
      return null;
  }
}
