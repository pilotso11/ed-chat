import type { JournalEvent, JournalState } from "ed-mcp/journal";
import { DEFAULT_MINING_TARGETS, type Settings } from "../settings.js";
import { credits, shortBody, type HudRow, type PanelView } from "./panels.js";
import type { SellHit, SellLookup, SellQuery } from "./sell.js";

import { num, objs, str, type Obj } from "./json.js";

// ---------- Commodity names ----------

/**
 * What mining gives, by commodityKey(), in English as the market and Spansh spell it. The journal
 * names these several ways: "$platinum_name;", "LowTemperatureDiamond", "Low Temperature
 * Diamonds", "opal".
 */
const MINED: Record<string, string> = {
  alexandrite: "Alexandrite",
  bauxite: "Bauxite",
  benitoite: "Benitoite",
  bertrandite: "Bertrandite",
  bromellite: "Bromellite",
  cobalt: "Cobalt",
  coltan: "Coltan",
  cryolite: "Cryolite",
  gallite: "Gallite",
  gold: "Gold",
  goslarite: "Goslarite",
  grandidierite: "Grandidierite",
  hydrogenperoxide: "Hydrogen Peroxide",
  indite: "Indite",
  jadeite: "Jadeite",
  lepidolite: "Lepidolite",
  liquidoxygen: "Liquid oxygen",
  lithiumhydroxide: "Lithium Hydroxide",
  lowtemperaturediamond: "Low Temperature Diamonds",
  methaneclathrate: "Methane Clathrate",
  methanolmonohydratecrystals: "Methanol Monohydrate Crystals",
  moissanite: "Moissanite",
  monazite: "Monazite",
  musgravite: "Musgravite",
  opal: "Void Opal",
  osmium: "Osmium",
  painite: "Painite",
  palladium: "Palladium",
  platinum: "Platinum",
  praseodymium: "Praseodymium",
  pyrophyllite: "Pyrophyllite",
  rhodplumsite: "Rhodplumsite",
  rutile: "Rutile",
  samarium: "Samarium",
  serendibite: "Serendibite",
  silver: "Silver",
  taaffeite: "Taaffeite",
  thorium: "Thorium",
  tritium: "Tritium",
  uraninite: "Uraninite",
  water: "Water",
};

const ALIASES: Record<string, string> = {
  lowtemperaturediamonds: "lowtemperaturediamond",
  lowtempdiamonds: "lowtemperaturediamond",
  voidopal: "opal",
  voidopals: "opal",
  limpet: "drones",
  limpets: "drones",
};

/** One key for each way the journal names a commodity: "$platinum_name;" and "Platinum" match. */
export function commodityKey(name: string): string {
  const k = name
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/_name;$/, "")
    .replace(/[^a-z]/g, "");
  return ALIASES[k] ?? k;
}

/** The commodity's English name; an unknown one is spaced out from its journal name. */
export function commodityName(key: string, fallback?: string): string {
  if (MINED[key]) return MINED[key];
  const f = (fallback ?? key).replace(/^\$|_name;$/g, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return f.charAt(0).toUpperCase() + f.slice(1);
}

export const isMined = (key: string) => key in MINED;

// ---------- The journal ----------

export interface Prospect {
  at: number;
  /** Highest proportion first. */
  materials: { key: string; name: string; percent: number }[];
  content: "High" | "Medium" | "Low" | null;
  remaining: number | null;
  motherlode: string | null;
}

export interface MiningState {
  /** The ring being mined, when the journal or Status.json says. */
  ring: string | null;
  /** The newest prospect since the rocks last reset (leaving the ring, or a relog). */
  prospect: Prospect | null;
  /** The mining session's prospects, for the counts; a session ends after two hours idle. */
  prospects: Prospect[];
  cracked: number;
  /** The ring's hotspots, from its surface scan. */
  hotspots: { name: string; count: number }[];
  /** Tons mined this session (refined, or collected from a cracked core), by commodityKey(). */
  refined: Map<string, number>;
  /** Tons per hour, over the last 15 minutes of mining; null when too little to say. */
  rate: number | null;
  /**
   * The system of the newest mining event, buyers are searched from it rather than again at each
   * jump. Null more than three jumps away, or after a login or respawn in another system; a jump
   * or login back there makes it the origin again. A relog in the same system keeps it.
   */
  system: string | null;
  /**
   * When the hold was last emptied of mined cargo: a sale of a mined commodity, or a move to the
   * carrier (selling limpets does not count). A new trip after it copies the buyer again.
   */
  lastSale: string | null;
}

const RATE_WINDOW_MS = 15 * 60_000;

const LEAVE_EVENTS = new Set(["FSDJump", "CarrierJump", "SupercruiseEntry", "Died"]);

/**
 * Docked, or logged in docked, at a station rather than a carrier (fleet or squadron, which can sit
 * at a ring).
 */
const dockedAtStation = (e: JournalEvent) =>
  (e.event === "Docked" || (e.event === "Location" && e.Docked === true)) &&
  !/Carrier$/i.test(String(e.StationType ?? ""));

/**
 * Whether the event takes the ship out of the ring it was mining: a jump, supercruise, death, or
 * docking at a station. Docking at a carrier beside the ring does not, nor relogging there. The
 * one rule for the ring.
 */
function leavesRing(e: JournalEvent, here: string | null = null): boolean {
  // A login in another system (a carrier that jumped while logged out) is away from the ring too.
  const moved = e.event === "Location" && here !== null && str(e.StarSystem) !== here;
  return LEAVE_EVENTS.has(e.event) || dockedAtStation(e) || moved;
}

/**
 * Whether the rocks seen before the event are gone: leaving the ring, or a relog (LoadGame, or the
 * Location written at login), which resets them. The one rule for the prospect and the cracked
 * core.
 */
const rocksReset = (e: JournalEvent) =>
  leavesRing(e) || e.event === "LoadGame" || e.event === "Location";

/**
 * Follows the journal for cargo collected from a cracked core: the returned function gives, for
 * each event in order, a fragment's commodityKey(), else null. One tracker for miningState() and
 * refinedKinds(), so they agree.
 */
function fragmentTracker(): (e: JournalEvent) => string | null {
  let cracked = false;
  return (e) => {
    if (e.event === "AsteroidCracked") cracked = true;
    else if (rocksReset(e)) cracked = false;
    else if (e.event === "CollectCargo" && cracked && e.Stolen !== true) {
      const key = commodityKey(str(e.Type) ?? "");
      return isMined(key) ? key : null;
    }
    return null;
  };
}
/** This long without mining ends a mining session: its counts start again. */
const SESSION_GAP_MS = 2 * 3_600_000;
/** Buyers are searched from the mining system for this many jumps, then from where the ship is. */
const SEARCH_FROM_MINING_JUMPS = 3;

const sameSystem = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const RATE_MIN_MS = 3 * 60_000;

function prospectOf(e: JournalEvent, at: number): Prospect {
  const materials = objs(e.Materials)
    .map((m) => {
      const raw = str(m.Name) ?? "";
      const key = commodityKey(raw);
      return {
        key,
        name: commodityName(key, str(m.Name_Localised) ?? raw),
        percent: num(m.Proportion) ?? 0,
      };
    })
    .sort((a, b) => b.percent - a.percent);
  const c = /High|Medium|Low/.exec(String(e.Content ?? ""))?.[0] as Prospect["content"];
  const ml = str(e.MotherlodeMaterial);
  return {
    at,
    materials,
    content: c ?? null,
    remaining: num(e.Remaining),
    motherlode: ml
      ? commodityName(commodityKey(ml), str(e.MotherlodeMaterial_Localised) ?? ml)
      : null,
  };
}

/** What the journal says about mining: this session, and since arriving in the system. */
export function miningState(
  events: JournalEvent[],
  now: number,
  statusBody: string | null = null,
): MiningState {
  const prospects: Prospect[] = [];
  const refined = new Map<string, number>();
  const refinedAt: number[] = [];
  let prospect: Prospect | null = null;
  let ring: string | null = null;
  let cracked = 0;
  let stintStart: number | null = null;
  let last = 0;
  let here: string | null = null;
  let system: string | null = null;
  let lastSale: string | null = null;
  let lastMining = 0;
  let jumpsSince = 0;
  // Logged in, or respawned, in a system other than the mining system.
  let away = false;
  const fragment = fragmentTracker();
  const rings = new Map<string, { name: string; count: number }[]>();
  const mined = () => {
    // A long break starts a new session; a relog does not, since miners relog to reset rocks.
    if (lastMining && last - lastMining > SESSION_GAP_MS) {
      prospects.length = 0;
      refined.clear();
      refinedAt.length = 0;
      cracked = 0;
    }
    // After a break (docked, or away), the rate counts from when mining started again.
    if (stintStart !== null && last - lastMining > RATE_WINDOW_MS) stintStart = last;
    stintStart ??= last;
    lastMining = last;
    system = here;
    jumpsSince = 0;
    away = false;
  };
  for (const e of events) {
    last = Date.parse(e.timestamp) || last;
    const piece = fragment(e);
    // No longer mining here, though the session's counts stay.
    if (leavesRing(e, here)) {
      ring = null;
      stintStart = null;
    }
    if (rocksReset(e)) prospect = null;
    switch (e.event) {
      case "Location": {
        // Written at login and after a respawn: away from the mining system when it is another
        // system (a carrier that jumped while logged out, say), back when it is the same one.
        const at = str(e.StarSystem);
        if (at && system) away = !sameSystem(at, system);
        here = at ?? here;
        break;
      }
      case "FSDJump":
      case "CarrierJump": {
        here = str(e.StarSystem) ?? here;
        // A carrier jump moves the ship too. Back in the mining system, it is searched from again.
        if (here && system && sameSystem(here, system)) {
          jumpsSince = 0;
          away = false;
        } else jumpsSince++;
        break;
      }
      case "MarketSell":
        // Selling what was mined this session ends the trip; limpets or bought goods do not.
        if (refined.has(commodityKey(str(e.Type) ?? ""))) lastSale = e.timestamp;
        break;
      case "CargoTransfer":
        // Mined cargo moved to the carrier: the next full hold is a new trip. Moving other cargo
        // (limpets, trade goods) is not.
        if (
          objs(e.Transfers).some(
            (x) => x.Direction === "tocarrier" && refined.has(commodityKey(str(x.Type) ?? "")),
          )
        ) {
          lastSale = e.timestamp;
        }
        break;
      case "SupercruiseExit":
        if (e.BodyType === "PlanetaryRing") ring = str(e.Body);
        break;
      case "SAASignalsFound": {
        const body = str(e.BodyName);
        if (!body || !/ring$/i.test(body)) break;
        rings.set(
          body.toLowerCase(),
          objs(e.Signals).map((s) => {
            const t = str(s.Type) ?? "";
            return {
              name: commodityName(commodityKey(t), str(s.Type_Localised) ?? t),
              count: num(s.Count) ?? 1,
            };
          }),
        );
        break;
      }
      // mined() first: a new session clears the counts before this event adds to them.
      case "ProspectedAsteroid":
        mined();
        prospect = prospectOf(e, last);
        prospects.push(prospect);
        break;
      case "AsteroidCracked":
        mined();
        cracked++;
        ring = str(e.Body) ?? ring;
        break;
      case "CollectCargo": {
        // Fragments from a cracked core count as mined, like refined tons.
        if (!piece) break;
        mined();
        refined.set(piece, (refined.get(piece) ?? 0) + 1);
        refinedAt.push(last);
        break;
      }
      case "MiningRefined": {
        mined();
        const key = commodityKey(str(e.Type) ?? str(e.Type_Localised) ?? "");
        // An event with no readable type still counts toward the rate.
        if (key) refined.set(key, (refined.get(key) ?? 0) + 1);
        refinedAt.push(last);
        break;
      }
      case "LaunchDrone":
        if (e.Type === "Prospector") mined();
        break;
    }
  }
  // Status.json names the ring more exactly, but only while still mining: after leaving, the
  // ship can still be near it.
  if (statusBody && /ring$/i.test(statusBody) && (ring !== null || prospect !== null)) {
    ring = statusBody;
  }
  let rate: number | null = null;
  const lastRefined = refinedAt.at(-1);
  if (stintStart !== null && lastRefined !== undefined && now - lastRefined < RATE_WINDOW_MS) {
    const span = Math.min(RATE_WINDOW_MS, now - stintStart);
    const tons = refinedAt.filter((t) => t >= now - span).length;
    if (span >= RATE_MIN_MS) rate = Math.round((tons / span) * 3_600_000);
  }
  return {
    ring,
    prospect,
    prospects,
    cracked,
    hotspots: (ring && rings.get(ring.toLowerCase())) || [],
    refined,
    rate,
    lastSale,
    system: !away && jumpsSince <= SEARCH_FROM_MINING_JUMPS ? system : null,
  };
}

const kindsMemo = new WeakMap<JournalEvent[], Set<string>>();

/**
 * The commodities the player has mined and not bought since, by commodityKey(): refined by laser,
 * or collected as fragments after cracking a core. Cargo of these counts as mined, however long
 * ago: Gold bought to trade after mining Gold does not. Buying back from the player's own carrier
 * only moves the cargo, so it keeps the mark.
 */
export function refinedKinds(events: JournalEvent[]): Set<string> {
  const memo = kindsMemo.get(events);
  if (memo) return memo;
  // Buying back from the carrier keeps the mark, even while a decommission is pending.
  const own = ownCarrierId(events, -Infinity);
  const kinds = new Set<string>();
  const fragment = fragmentTracker();
  for (const e of events) {
    const piece = fragment(e);
    if (piece) kinds.add(piece);
    else if (e.event === "MiningRefined") {
      const key = commodityKey(str(e.Type) ?? str(e.Type_Localised) ?? "");
      if (key) kinds.add(key);
    } else if (e.event === "MarketBuy" && (own === null || num(e.MarketID) !== own)) {
      kinds.delete(commodityKey(str(e.Type) ?? ""));
    }
  }
  kindsMemo.set(events, kinds);
  return kinds;
}

/** Mined commodities in the ship's hold, by commodityKey(), and the limpets. */
export function holdOf(
  cargo: JournalState["cargo"],
  kinds: Set<string> | null = null,
): {
  mined: Map<string, number>;
  limpets: number;
  used: number;
} {
  const mined = new Map<string, number>();
  let limpets = 0;
  let used = 0;
  for (const c of cargo) {
    used += c.count;
    const key = commodityKey(c.name);
    if (key === "drones") limpets += c.count;
    // Stolen cargo goes to a black market, not the buyers suggested here.
    else if (c.mission_id === null && !c.stolen && isMined(key) && (!kinds || kinds.has(key))) {
      mined.set(key, (mined.get(key) ?? 0) + c.count);
    }
  }
  return { mined, limpets, used };
}

// ---------- The fleet carrier ----------

export interface Carrier {
  id: number;
  callsign: string | null;
  name: string | null;
  /** Where it is, or will be once a jump that has left lands. */
  system: string | null;
  /** A jump booked and not yet left. */
  jumping: { system: string; departs: number | null } | null;
  /** From the newest carrier management screen, less the cargo moved since. */
  freeSpace: number | null;
  /** Mined commodities moved to the carrier in the last 12 hours, by commodityKey(). */
  moved: Map<string, number>;
}

/** Cargo moved to the carrier counts as waiting to be sold for this long. */
const MOVED_FOR_MS = 12 * 3_600_000;

/** A jump booked without a departure time leaves about this long after it is booked. */
const CARRIER_COUNTDOWN_MS = 15 * 60_000;

const isFleetCarrier = (e: JournalEvent) =>
  e.CarrierType === undefined || e.CarrierType === "FleetCarrier";

/** The player's own fleet carrier's ID (its market ID too); null when the journal shows none. */
export function ownCarrierId(events: JournalEvent[], now = Infinity): number | null {
  let id: number | null = null;
  let scrapped: { id: number; at: number } | null = null;
  for (const e of events) {
    if (
      (e.event === "CarrierBuy" || e.event === "CarrierStats" || e.event === "CarrierLocation") &&
      isFleetCarrier(e)
    ) {
      id = num(e.CarrierID) ?? id;
    } else if (e.event === "CarrierDecommission" && num(e.CarrierID) !== null) {
      // A request: the carrier goes at ScrapTime (Unix seconds), unless cancelled.
      const at = num(e.ScrapTime);
      // Without a scrap time it is not known to go: keep it.
      scrapped = { id: num(e.CarrierID)!, at: at === null ? Infinity : at * 1000 };
    } else if (e.event === "CarrierCancelDecommission" && num(e.CarrierID) === scrapped?.id) {
      scrapped = null;
    }
  }
  return scrapped && scrapped.id === id && now >= scrapped.at ? null : id;
}

// The feed reads a new events array each poll, and a render reads it several times.
const carrierMemo = new WeakMap<JournalEvent[], { minute: number; c: Carrier | null }>();

/** The player's own fleet carrier, from the journal; null when the journal never shows one. */
export function carrierState(events: JournalEvent[], now: number): Carrier | null {
  // The carrier's place depends on the time only through a jump landing: a minute is close enough.
  const minute = Math.floor(now / 60_000);
  const memo = carrierMemo.get(events);
  if (memo?.minute === minute) return memo.c;
  const c = readCarrier(events, now);
  carrierMemo.set(events, { minute, c });
  return c;
}

function readCarrier(events: JournalEvent[], now: number): Carrier | null {
  const id = ownCarrierId(events, now);
  if (id === null) return null;
  const c: Carrier = {
    id,
    callsign: null,
    name: null,
    system: null,
    jumping: null,
    freeSpace: null,
    moved: new Map(),
  };
  // A booked jump. In an object: TypeScript narrows a plain let to null after the loop, since it
  // does not follow assignments made inside the land() closure.
  const jump: { pending: { system: string; departs: number } | null } = { pending: null };
  let last = 0;
  // Cargo moves only count while docked at this carrier, not at a squadron carrier.
  let aboard = false;
  const move = (name: string, tons: number) => {
    const key = commodityKey(name);
    if (c.freeSpace !== null) c.freeSpace -= tons;
    // Sales from the carrier are not in the journal, so only recent moves count as waiting.
    if (isMined(key) && now - last <= MOVED_FOR_MS) {
      c.moved.set(key, Math.max(0, (c.moved.get(key) ?? 0) + tons));
    }
  };
  const land = () => {
    if (jump.pending && last >= jump.pending.departs) {
      c.system = jump.pending.system;
      jump.pending = null;
    }
  };
  for (const e of events) {
    last = Date.parse(e.timestamp) || last;
    land();
    const mine = num(e.CarrierID) === id || num(e.MarketID) === id;
    switch (e.event) {
      case "CarrierBuy":
        if (mine) {
          c.callsign = str(e.Callsign) ?? c.callsign;
          c.system = str(e.Location) ?? c.system;
        }
        break;
      case "CarrierStats":
        if (mine) {
          c.callsign = str(e.Callsign) ?? c.callsign;
          c.name = str(e.Name) ?? c.name;
          c.freeSpace = num((e.SpaceUsage as Obj | undefined)?.FreeSpace);
        }
        break;
      case "CarrierLocation":
        if (mine) c.system = str(e.StarSystem) ?? c.system;
        break;
      case "CarrierJumpRequest":
        if (mine && str(e.SystemName)) {
          const departs = Date.parse(String(e.DepartureTime ?? ""));
          jump.pending = {
            system: str(e.SystemName)!,
            departs: Number.isNaN(departs) ? last + CARRIER_COUNTDOWN_MS : departs,
          };
        }
        break;
      case "CarrierJumpCancelled":
        if (mine) jump.pending = null;
        break;
      case "Docked":
        aboard = mine;
        if (mine) {
          c.system = str(e.StarSystem) ?? c.system;
          c.callsign = str(e.StationName) ?? c.callsign;
        }
        break;
      case "CarrierJump":
        if (mine) {
          c.system = str(e.StarSystem) ?? c.system;
          jump.pending = null;
        }
        break;
      case "Location":
        // Logging in docked at the carrier writes Location, not Docked.
        aboard = e.Docked === true && mine;
        if (mine) c.system = str(e.StarSystem) ?? c.system;
        break;
      case "Undocked":
        aboard = false;
        break;
      case "CargoTransfer":
        if (!aboard) break;
        for (const t of objs(e.Transfers)) {
          const tons = num(t.Count) ?? 0;
          const name = str(t.Type) ?? "";
          if (t.Direction === "tocarrier") move(name, tons);
          else if (t.Direction === "toship") move(name, -tons);
        }
        break;
      case "MarketSell":
        // Selling to the carrier's own buy order moves the cargo onto it.
        if (mine) move(str(e.Type) ?? "", num(e.Count) ?? 0);
        break;
      case "MarketBuy":
        if (mine) move(str(e.Type) ?? "", -(num(e.Count) ?? 0));
        break;
    }
  }
  last = Math.max(last, now);
  land();
  if (jump.pending) c.jumping = { ...jump.pending };
  return c;
}

// ---------- Where to sell ----------

export const LARGE: ReadonlySet<string> = new Set([
  "anaconda",
  "anacondamkii",
  "belugaliner",
  "cutter",
  "empire_trader",
  "explorer_nx",
  "federation_corvette",
  "orca",
  "panthermkii",
  "type7",
  "type9",
  "type9_military",
]);
export const SMALL: ReadonlySet<string> = new Set([
  "adder",
  "cobramkiii",
  "cobramkiv",
  "cobramkv",
  "diamondback",
  "diamondbackxl",
  "dolphin",
  "eagle",
  "empire_courier",
  "empire_eagle",
  "hauler",
  "sidewinder",
  "viper",
  "viper_mkiv",
  "smallcombat01_nx",
  "vulture",
]);

// Medium-pad ships by the journal's names.
export const MEDIUM: ReadonlySet<string> = new Set([
  "asp",
  "asp_scout",
  "corsair",
  "federation_dropship",
  "federation_dropship_mkii",
  "federation_gunship",
  "ferdelance",
  "independant_trader",
  "krait_light",
  "krait_mkii",
  "lakonminer",
  "mamba",
  "mandalay",
  "python",
  "python_nx",
  "type6",
  "type8",
  "typex",
  "typex_2",
  "typex_3",
]);

/**
 * The landing pad the ship needs, from SMALL, MEDIUM and LARGE; null with no ship type. A hull on
 * no list (a new one, say) is taken as large, the safe side: a large ship sent to a smaller pad
 * cannot dock, while a small or medium ship taken as large only sees fewer stations (outposts
 * and medium-only stations are left out). So the lists must name every small and medium hull.
 */
export function padFor(shipType: string | null): "L" | "M" | "S" | null {
  if (!shipType) return null;
  const t = shipType.toLowerCase();
  if (SMALL.has(t)) return "S";
  if (MEDIUM.has(t)) return "M";
  // LARGE, and any hull not listed yet.
  return "L";
}

const fits = (h: SellHit, pad: "L" | "M" | "S" | null) =>
  pad === "L" ? h.largePad : pad === "M" ? h.largePad || h.mediumPad : true;

/** A place that pays nearly as much is worth a shorter trip. */
const NEAR_SHARE = 0.9;

/**
 * The best price that takes the whole load (else the best price), and a nearer station paying
 * at least 90% of it. The player's own carrier is left out: selling to it moves no money.
 */
export function pickSell(
  hits: SellHit[],
  tons: number,
  pad: "L" | "M" | "S" | null,
  ownCarrier: number | null,
): { best: SellHit; near: SellHit | null } | null {
  const ok = hits.filter((h) => fits(h, pad) && (ownCarrier === null || h.marketId !== ownCarrier));
  if (!ok.length) return null;
  const takesAll = ok.filter((h) => h.demand === null || h.demand >= tons);
  const pool = takesAll.length ? takesAll : ok;
  const best = [...pool].sort((a, b) => b.price - a.price || a.distanceLy - b.distanceLy)[0]!;
  const near =
    [...pool]
      .filter(
        (h) => h !== best && h.distanceLy < best.distanceLy && h.price >= best.price * NEAR_SHARE,
      )
      .sort((a, b) => a.distanceLy - b.distanceLy)[0] ?? null;
  return { best, near };
}

export interface ToSell {
  key: string;
  name: string;
  tons: number;
  query: SellQuery;
}

const MAX_SELL_ROWS = 3;

interface SellInput {
  system: string | null;
  hold: Map<string, number>;
  carrier: Carrier | null;
  /** The mining system: buyers are searched from it, so a trip to sell does not search again. */
  from?: string | null;
  /** refinedKinds(): only these count on the carrier; null counts every minable commodity. */
  kinds?: Set<string> | null;
  shipType: string | null;
  settings: Settings["hud"]["mining"];
}

/** The carrier to sell from: when the setting is on and where it is, or is going, is known. */
function sellingCarrier(input: SellInput): Carrier | null {
  const c = input.carrier;
  return input.settings.useCarrier && (c?.system || c?.jumping) ? c : null;
}

/** The search for one commodity's buyers: around the carrier when selling from it, else the ship. */
function queryFor(input: SellInput, key: string): SellQuery | null {
  const s = input.settings;
  const fromCarrier = sellingCarrier(input);
  // A booked jump: the cargo will be sold from where the carrier is going.
  const near = fromCarrier?.jumping?.system ?? fromCarrier?.system ?? input.from ?? input.system;
  if (!near) return null;
  return {
    near,
    commodity: commodityName(key),
    radiusLy: fromCarrier ? s.carrierRadiusLy : s.sellRadiusLy,
    pad: padFor(input.shipType),
    carriers: s.carrierMarkets,
    maxAgeDays: s.maxPriceAgeDays,
  };
}

/** The mined tons to sell, by commodity, most first. */
function tonsToSell(input: SellInput): [string, number][] {
  const fromCarrier = sellingCarrier(input);
  const tons = new Map(input.hold);
  for (const [k, n] of fromCarrier?.moved ?? []) {
    if (!input.kinds || input.kinds.has(k)) tons.set(k, (tons.get(k) ?? 0) + n);
  }
  return [...tons].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
}

/**
 * What to look up a buyer for: the mined commodities in the hold, plus those moved to the carrier
 * when selling from it, most tons first.
 */
export function sellQueries(input: SellInput): ToSell[] {
  const out: ToSell[] = [];
  for (const [key, n] of tonsToSell(input)) {
    if (out.length === MAX_SELL_ROWS) break;
    const query = queryFor(input, key);
    if (query) out.push({ key, name: commodityName(key), tons: n, query });
  }
  return out;
}

// ---------- The panel ----------

/**
 * Mining targets by commodityKey(), for judge(): the defaults, then the player's entries over
 * them whatever their spelling; null removes a default.
 */
export function targetsMap(
  player: Record<string, number | null>,
  defaults: Readonly<Record<string, number>> = {},
): Map<string, number> {
  const m = new Map(Object.entries(defaults).map(([k, v]) => [commodityKey(k), v]));
  for (const [k, v] of Object.entries(player)) {
    if (v === null) m.delete(commodityKey(k));
    else m.set(commodityKey(k), v);
  }
  return m;
}

/** The prospect's material that best clears its target, else its richest; null when none listed. */
export function judge(
  p: Prospect,
  t: Map<string, number>,
): { name: string; percent: number; worth: boolean } | null {
  let best: { name: string; percent: number; worth: boolean; score: number } | null = null;
  for (const m of p.materials) {
    const min = t.get(m.key);
    const score = min === undefined ? -1 : m.percent / Math.max(min, 0.01);
    const worth = min !== undefined && m.percent >= min;
    if (!best || score > best.score) best = { name: m.name, percent: m.percent, worth, score };
  }
  return best && { name: best.name, percent: best.percent, worth: best.worth };
}

/** How old a price is, once over a day: "3d old". */
function priceAge(h: SellHit, now: number): string | null {
  const t = h.updatedAt ? Date.parse(h.updatedAt) : NaN;
  const days = Math.floor((now - t) / 86_400_000);
  return days >= 1 ? `${days}d old` : null;
}

const ly = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ly`;
const pct = (n: number) => `${n.toFixed(1)}%`;

export function miningPanel(input: {
  system: string | null;
  state: MiningState;
  /** The journal, for which commodities the player refined; without it, any minable counts. */
  events?: JournalEvent[];
  cargo: JournalState["cargo"];
  capacity: number | null;
  shipType: string | null;
  carrier: Carrier | null;
  settings: Settings["hud"]["mining"];
  now: number;
  /** Spansh's sale prices; none when the lookup is off. */
  sell?: (q: SellQuery) => SellLookup;
}): PanelView {
  const { state, settings } = input;
  const rows: HudRow[] = [];
  // The player's entries change or add to the defaults, one commodity at a time.
  const targets = targetsMap(settings.targets, DEFAULT_MINING_TARGETS);
  const p = state.prospect;
  if (p) {
    const j = judge(p, targets);
    const left =
      p.remaining !== null && p.remaining < 100 ? ` · ${Math.round(p.remaining)}% left` : "";
    if (j) {
      const others = p.materials
        .filter((m) => m.name !== j.name)
        .map((m) => `${m.name} ${pct(m.percent)}`);
      rows.push({
        text: `${j.name} ${pct(j.percent)}${p.content ? ` · ${p.content}` : ""}${left}`,
        right: j.worth ? "MINE" : "skip",
        tone: j.worth ? "good" : "dim",
        ...(others.length ? { detail: others.join(" · ") } : {}),
      });
    } else if (!p.motherlode) {
      // A rock with nothing worth listing (or only a core): still say it was read.
      rows.push({
        text: `No materials${p.content ? ` · ${p.content}` : ""}${left}`,
        right: "skip",
        tone: "dim",
      });
    }
    if (p.motherlode)
      rows.push({ text: `Motherlode: ${p.motherlode}`, right: "crack", tone: "warn" });
  } else {
    rows.push({ text: "Prospect a rock", tone: "dim" });
  }
  if (state.hotspots.length) {
    const spots = state.hotspots.map((h) => `${h.name}${h.count > 1 ? ` ×${h.count}` : ""}`);
    rows.push({ text: `Hotspots: ${spots.join(" · ")}`, tone: "dim" });
  }

  const kinds = input.events ? refinedKinds(input.events) : null;
  const hold = holdOf(input.cargo, kinds);
  const free = input.capacity !== null ? Math.max(0, input.capacity - hold.used) : null;
  rows.push({
    text: input.capacity !== null ? `Hold ${hold.used}/${input.capacity} t` : `Hold ${hold.used} t`,
    right: [free !== null ? `${free} t free` : null, `${hold.limpets} limpets`]
      .filter(Boolean)
      .join(" · "),
    tone: free === 0 || hold.limpets === 0 ? "warn" : undefined,
    ...(input.capacity ? { bar: Math.min(1, hold.used / input.capacity) } : {}),
  });

  const carrier = settings.useCarrier ? input.carrier : null;
  if (settings.useCarrier) {
    if (!carrier) {
      rows.push({
        text: "Carrier: not in the journal yet. Log in or open carrier management",
        tone: "dim",
      });
    } else {
      // Only what was mined: traded cargo moved to the carrier is not waiting here.
      const moved = [...carrier.moved]
        .filter(([k]) => !kinds || kinds.has(k))
        .reduce((n, [, t]) => n + t, 0);
      const where = carrier.jumping
        ? `→ ${carrier.jumping.system}`
        : (carrier.system ?? "location unknown");
      rows.push({
        text: [`Carrier${carrier.callsign ? ` ${carrier.callsign}` : ""}`, where].join(" · "),
        right: [
          moved ? `${moved} t moved` : null,
          carrier.freeSpace !== null ? `${carrier.freeSpace.toLocaleString("en-US")} t free` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }

  // Where to sell: the best price and a nearer place paying nearly as much.
  const sellInput: SellInput = {
    system: input.system,
    hold: hold.mined,
    carrier: input.carrier,
    from: state.system,
    kinds,
    shipType: input.shipType,
    settings,
  };
  const toSell = sellQueries(sellInput);
  // Still mining here: not on the way to a buyer, where the route copies the next stop.
  const mining = state.prospect !== null || state.ring !== null;
  const pad = padFor(input.shipType);
  // Distances are from where the search was made: say so when that is not here.
  const from = (near: string) => (near !== input.system ? ` from ${near}` : "");
  // What the cargo sells for at the best buyers; "+" when some of it has no price.
  let worth = 0;
  let unpriced = toSell.length < tonsToSell(sellInput).length;
  let copy: PanelView["copy"];
  for (const t of toSell) {
    const found = input.sell?.(t.query);
    if (!found) continue;
    unpriced ||= !Array.isArray(found);
    if (found === "pending" || found === "failed") {
      rows.push({
        text: `Sell ${t.name} ${t.tons} t`,
        right: found === "pending" ? "looking up…" : "Spansh lookup failed",
        tone: "dim",
      });
      continue;
    }
    const pick = pickSell(found, t.tons, pad, input.carrier?.id ?? null);
    if (!pick) {
      unpriced = true;
      rows.push({
        text: `Sell ${t.name} ${t.tons} t`,
        // Buyers found but none usable says why, rather than that there are none.
        right: !found.length
          ? `no buyer within ${t.query.radiusLy} ly`
          : found.every((h) => h.marketId !== null && h.marketId === input.carrier?.id)
            ? "only your own carrier buys"
            : "no buyer with a pad for this ship",
        tone: "dim",
      });
      continue;
    }
    worth += pick.best.price * t.tons;
    // The load's value on the row; the price a ton with the buyer.
    const place = (h: SellHit) =>
      [
        `${h.station}${h.carrier ? " (carrier)" : ""}, ${h.system}`,
        `${credits(h.price)}/t`,
        h.demand !== null && h.demand < t.tons ? `demand ${h.demand}` : null,
        priceAge(h, input.now),
      ]
        .filter(Boolean)
        .join(" · ");
    const right = (h: SellHit) =>
      `${credits(h.price * t.tons)} · ${ly(h.distanceLy)}${from(t.query.near)}`;
    rows.push({
      text: `Sell ${t.name} ${t.tons} t`,
      right: right(pick.best),
      detail: place(pick.best),
      tone: "accent",
    });
    if (pick.near) {
      rows.push({
        text: "  or nearer",
        right: right(pick.near),
        detail: place(pick.near),
        tone: "dim",
      });
    }
    // A full hold copies the best buyer's system for the galaxy map, once, while still mining,
    // unless the load goes to the carrier.
    if (!copy && !carrier && mining && free === 0 && pick.best.system !== input.system) {
      copy = {
        key: `hold-full|${state.lastSale ?? ""}`,
        text: pick.best.system,
        note: `hold full: ${t.name} sells best at ${pick.best.station}, ${pick.best.system} (copied)`,
      };
    }
  }

  const worthCount = state.prospects.filter((x) => judge(x, targets)?.worth).length;
  const motherlodes = state.prospects.filter((x) => x.motherlode).length;
  const refinedTons = [...state.refined.values()].reduce((a, b) => a + b, 0);
  const session = [
    state.prospects.length ? `${state.prospects.length} prospected` : null,
    state.prospects.length ? `${worthCount} worth mining` : null,
    motherlodes ? `${motherlodes} motherlode${motherlodes === 1 ? "" : "s"}` : null,
    state.cracked ? `${state.cracked} cracked` : null,
    refinedTons ? `${refinedTons} t refined` : null,
  ].filter(Boolean);
  // What the cargo sells for ends the line, as the exploration panel's unsold data does.
  const toSellText = worth ? `${credits(worth)}${unpriced ? "+" : ""} to sell` : null;
  return {
    mode: "mining",
    title: "MINING",
    subtitle: state.ring ? shortBody(state.ring, input.system) : (input.system ?? undefined),
    right: state.rate !== null ? `${state.rate} t/h` : undefined,
    rows,
    footer: session.length
      ? [`Session: ${[...session, toSellText].filter(Boolean).join(" · ")}`]
      : toSellText
        ? [toSellText]
        : [],
    ...(copy ? { copy } : {}),
  };
}

/**
 * Whether mined cargo is waiting to be sold: in the hold, or moved to the carrier this session
 * when selling from it. Keeps mining mode on after leaving the ring.
 */
export function minedWaiting(
  cargo: JournalState["cargo"],
  events: JournalEvent[],
  now: number,
  settings: Settings["hud"]["mining"],
): boolean {
  const kinds = refinedKinds(events);
  if (!kinds.size) return false;
  if (holdOf(cargo, kinds).mined.size > 0) return true;
  // The carrier is read only when selling from it.
  if (!settings.useCarrier) return false;
  const carrier = carrierState(events, now);
  return [...(carrier?.moved ?? [])].some(([k, t]) => t > 0 && kinds.has(k));
}
