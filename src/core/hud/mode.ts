import type { JournalEvent } from "ed-mcp/journal";
import type { HudModeId } from "../settings.js";

/** Journal events the mode rules and panels read, besides the ones ed-mcp keeps. */
export const HUD_EVENTS = [
  "ApproachBody",
  "Touchdown",
  "LeaveBody",
  "SellExplorationData",
  "MultiSellExplorationData",
  "NavRoute",
  "NavRouteClear",
  // Mining and the fleet carrier.
  "ProspectedAsteroid",
  "MiningRefined",
  "AsteroidCracked",
  "LaunchDrone",
  "SupercruiseExit",
  "MarketBuy",
  "MarketSell",
  "CargoTransfer",
  "CarrierBuy",
  "CarrierStats",
  "CarrierLocation",
  "CarrierJumpRequest",
  "CarrierJumpCancelled",
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
 * a bio sample, turns on exobiology; a prospector, a prospect, refining or a cracked asteroid
 * turns on mining. A jump alone starts nothing, and LAPSE_JUMPS jumps with no scan end
 * exploration. A jump ends mining unless mined cargo is still aboard, to sell.
 * `massacreActive` is whether a massacre mission is still open now (from ed-mcp's massacre()).
 * `minedAboard` is whether the hold has mined commodities now.
 */
export function journalMode(
  events: JournalEvent[],
  massacreActive: boolean,
  minedAboard = false,
): Choice | null {
  const bio = new Set<string>();
  // Exploration and exobiology, followed through every event, before and during a stack.
  // Massacre is kept apart: while a stack is open it wins, and once it is handed in this mode is
  // current, as if there had been no missions.
  let mode: "exploration" | "exobiology" | "mining" | null = null;
  let at = 0;
  let massacreAt: number | null = null;
  // Whether the ship left the system after the last mining event.
  let leftMining = false;
  const set = (m: "exploration" | "exobiology" | "mining") => {
    jumps = 0;
    leftMining = false;
    mode = m;
    at = last;
  };
  // Jumps since the last exploration event: a trip home ends exploration mode.
  let jumps = 0;
  // The newest readable event time: an event's own, or for one with none, the one before it.
  let last = 0;
  for (const e of events) {
    last = Date.parse(e.timestamp) || last;
    const key = `${num(e.SystemAddress)}|${num(e.BodyID)}`;
    switch (e.event) {
      case "FSDJump":
      case "CarrierJump":
        if (e.event === "FSDJump") jumps++;
        if (mode === "exploration" && jumps >= LAPSE_JUMPS) mode = null;
        if (mode === "mining") leftMining = true;
        break;
      case "ProspectedAsteroid":
      case "MiningRefined":
      case "AsteroidCracked":
        set("mining");
        break;
      case "LaunchDrone":
        if (e.Type === "Prospector") set("mining");
        break;
      case "MissionAccepted":
        // An acceptance with no readable time still counts, dated by the newest readable event.
        if (isMassacre(e)) massacreAt = last;
        break;
      case "FSSDiscoveryScan":
        set("exploration");
        break;
      case "Scan":
        if (e.ScanType === "Detailed") set("exploration");
        break;
      case "FSSBodySignals":
      case "SAASignalsFound":
        if (bioCount(e) > 0) bio.add(key);
        break;
      case "ApproachBody":
      case "Touchdown":
        if (bio.has(key)) set("exobiology");
        break;
      case "ScanOrganic":
        set("exobiology");
        break;
      case "LeaveBody":
        if (mode === "exobiology") set("exploration");
        break;
    }
  }
  if (massacreActive && massacreAt !== null) return { mode: "massacre", at: massacreAt };
  if (mode === "mining" && leftMining && !minedAboard) return null;
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
    case "mining":
      return kind;
    default:
      return null;
  }
}
