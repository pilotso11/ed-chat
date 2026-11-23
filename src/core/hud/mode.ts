import type { JournalEvent } from "ed-mcp/journal";
import type { HudModeId } from "../settings.js";
import { num, objs, type Obj } from "./json.js";
import { atBuildStop, BUILD_EVENTS, NO_BUILD, type BuildNow } from "./build.js";
import { isDocking, stopAt, tradeJournal, type MissionsNow } from "./trade.js";

/** Journal events the mode rules and panels read, besides the ones ed-mcp keeps. */
export const HUD_EVENTS = [
  "ApproachBody",
  // Quitting stops the exploration rate's clocks (explorationTotals).
  "Shutdown",
  "Touchdown",
  "LeaveBody",
  "SellExplorationData",
  "MultiSellExplorationData",
  "NavRoute",
  "NavRouteClear",
  // Mining and the fleet carrier.
  "ProspectedAsteroid",
  "MiningRefined",
  "CollectCargo",
  "SupercruiseEntry",
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
  "CarrierDecommission",
  "CarrierCancelDecommission",
  // Read by the mining rules; ed-mcp keeps most of these for itself, but the panel does not rely
  // on that.
  "LoadGame",
  "Location",
  "FSDJump",
  "CarrierJump",
  "Docked",
  "Undocked",
  "Died",
  "Cargo",
  // Read by the passenger panel: cabins for the berths, and the run's acceptance.
  "Loadout",
  "MissionAccepted",
  // Read by the trade rules (tradeBuys()): mission cargo aboard, goods missions ask for, and
  // colonisation.
  "MissionCompleted",
  "MissionFailed",
  "MissionAbandoned",
  "EjectCargo",
  "CargoDepot",
  "ColonisationContribution",
  "ColonisationConstructionDepot",
  // The build panel's: module, shipyard and engineering events, and landing at a gather stop.
  ...BUILD_EVENTS,
] as const;

/** What the trade rules need to know now: see journalMode(). */
export interface TradeNow extends MissionsNow {
  /** The trade panel has something to show: a trade stop to do, or cargo to trade aboard. */
  active: boolean;
  /** Cargo to trade is aboard. */
  aboard: boolean;
  /** The trade plan's stops still to do: docking at one is following the plan. */
  stops: { system: string; station?: string }[];
}

const NO_TRADE: TradeNow = {
  active: false,
  aboard: false,
  missionCargo: [],
  wanted: [],
  stops: [],
};

/** The modes the journal's own events choose, besides massacre and passengers. */
type Journaled = "exploration" | "exobiology" | "mining" | "trade" | "build";

export interface Choice {
  mode: HudModeId | "off";
  /** Epoch ms. The newest choice wins. */
  at: number;
}

/** A passenger mission, or a delivery: goods to take to a station. */
// As passenger.ts's isRun, on the acceptance event: goods need a destination.
const isRun = (e: JournalEvent) =>
  typeof e.PassengerCount === "number" ||
  (typeof e.Commodity === "string" &&
    typeof e.Count === "number" &&
    typeof e.DestinationSystem === "string" &&
    !isMassacre(e));

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
 * exploration. A jump or a sale ends mining unless mined cargo is still waiting to be sold.
 * `massacreActive` is whether a massacre mission is still open now (from ed-mcp's massacre()).
 * `minedAboard` is whether mined cargo is waiting to be sold now (minedWaiting()).
 * `on` says which modes are turned on: a mode that is off changes no mode, so the one before it
 * (or a run) still shows.
 * `runActive` is whether the passenger panel has a run to show now (the mode on, and a passenger
 * or delivery mission open that it can place): taking one then turns on the passenger mode,
 * which lasts until a newer activity or the last such mission is done.
 * `trade` is the trade run now (TradeNow): a market buy that is trade (tradeBuys(): not limpets,
 * not for a mission or a colonisation depot), or docking at a stop of the trade plan, turns on
 * trade mode, which lasts while the panel has something to show (a trade stop to do, or cargo
 * aboard) and until a newer activity. LAPSE_JUMPS jumps with no market trade end it, unless trade
 * cargo is aboard on the way to a trade stop. A passenger or delivery mission taken after the
 * last trade shows the passenger panel; taken before, it shows on the trade panel's footer.
 * `build` is the build plans now (BuildNow): docking at an open build stop (landing, for a gather
 * stop), or an event that matched an open action of a build plan, turns on build mode, which lasts
 * while the panel has something to show and until a newer activity. A jump never ends it. A
 * Synthesis or MaterialTrade the plan does not ask for changes nothing; a ShipyardSwap turns it on
 * when it does a swap_ship action or the ship swapped to has an open build plan. With no build
 * plan with work where the ship is docked, outfitting, the shipyard or an engineer used this
 * docking turns it on for the outfitting visit (build.visit), which undocking ends.
 */
export function journalMode(
  events: JournalEvent[],
  massacreActive: boolean,
  minedAboard = false,
  on: (m: HudModeId) => boolean = () => true,
  runActive = false,
  trade: TradeNow = NO_TRADE,
  build: BuildNow = NO_BUILD,
): Choice | null {
  const bio = new Set<string>();
  // Exploration and exobiology, followed through every event, before and during a stack.
  // Massacre is kept apart: while a stack is open it wins, and once it is handed in this mode is
  // current, as if there had been no missions.
  let mode: Journaled | null = null;
  let at = 0;
  let massacreAt: number | null = null;
  // The newest passenger or delivery mission taken, which shows those missions while any is left.
  let runAt: number | null = null;
  // Whether the ship left the system after the last mining event.
  let leftMining = false;
  const set = (m: Journaled) => {
    if (!on(m)) return;
    jumps = 0;
    leftMining = false;
    mode = m;
    at = last;
  };
  const tradeStop = (e: JournalEvent) =>
    trade.stops.some((s) => stopAt(s, String(e.StarSystem ?? ""), String(e.StationName ?? "")));
  // Replayed only with trade on, and kept for the same journal (tradeJournal()).
  const traded = on("trade") ? tradeJournal(events, trade) : null;
  // Jumps since the last exploration event or market trade: a trip home ends exploration or
  // trade mode.
  let jumps = 0;
  // The newest readable event time: an event's own, or for one with none, the one before it.
  let last = 0;
  for (const e of events) {
    last = Date.parse(e.timestamp) || last;
    const key = `${num(e.SystemAddress)}|${num(e.BodyID)}`;
    // A build event the plan asked for, docking or landing at a build stop, swapping to a ship
    // with a build plan, or with no plan with work here, outfitting used this docking. Set after the rules below, so landing at a build's gather stop on a body
    // with biological signals is the build.
    const building =
      build.matched.has(e) ||
      build.visit.has(e) ||
      atBuildStop(e, build.stops) ||
      (e.event === "ShipyardSwap" && build.ships.includes(num(e.ShipID) ?? NaN));
    switch (e.event) {
      case "FSDJump":
      case "CarrierJump":
        if (e.event === "FSDJump") jumps++;
        if (mode === "exploration" && jumps >= LAPSE_JUMPS) mode = null;
        // A long haul with cargo to a trade stop is still a trade run.
        if (mode === "trade" && jumps >= LAPSE_JUMPS && !(trade.stops.length && trade.aboard))
          mode = null;
        if (mode === "mining") leftMining = true;
        break;
      case "MarketSell":
        // Selling ends mining once nothing mined is left. A relog does not: miners relog to reset
        // the asteroids.
        if (mode === "mining") leftMining = true;
        // Only a sale of traded cargo is a trade: not mined ore.
        if (mode === "trade" && traded?.sales.has(e)) jumps = 0;
        break;
      case "MarketBuy":
        // Limpets are not trade, and buying for a mission or a depot is not a trade run.
        if (traded?.buys.has(e)) set("trade");
        break;
      case "Docked":
      case "Location":
        if (isDocking(e) && tradeStop(e)) set("trade");
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
        else if (isRun(e)) runAt = last;
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
        // Leaving the body ends exobiology: exploration when it is on, else nothing.
        if (mode === "exobiology") {
          if (on("exploration")) set("exploration");
          else mode = null;
        }
        break;
    }
    if (building) set("build");
  }
  if (massacreActive && massacreAt !== null && on("massacre"))
    return { mode: "massacre", at: massacreAt };
  if (mode === "mining" && leftMining && !minedAboard) mode = null;
  // Trade ends once the hold is empty with no trade stop to do: an empty panel never wins.
  if (mode === "trade" && !trade.active) mode = null;
  if (mode === "build" && !build.active) mode = null;
  // Passengers and deliveries show from when they were taken until another activity is newer,
  // trade too: taken before the run's last trade, they show on the trade panel.
  if (runActive && runAt !== null && (mode === null || runAt >= at)) {
    return { mode: "passenger", at: runAt };
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
    case "mining":
      return kind;
    case "trading":
      return "trade";
    case "engineering":
      return "build";
    case "missions":
    case "hauling":
      return "passenger";
    default:
      return null;
  }
}
