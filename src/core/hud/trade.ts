import {
  visitOrder,
  type JournalEvent,
  type JournalState,
  type Mission,
  type Plan,
} from "ed-mcp/journal";
import { num, objs, same, str } from "./json.js";
import { commodityKey } from "./mining.js";
import { isRun } from "./passenger.js";
import {
  credits,
  currentStop,
  jumpsLeft,
  rateText,
  timeLeft,
  type HudRow,
  type NavRoute,
  type PanelView,
  type Tone,
} from "./panels.js";
import { ActiveClock, rates, type Rates } from "./rate.js";

// The trade panel: the trade plan's current stop and what to buy or sell there, the hold and the
// market against the plan, the session's profit an hour, and when a stop's action is done.

type Stop = Plan["stops"][number];
type Cargo = NonNullable<Stop["cargo"]>[number];

/**
 * Every journal event the trade panel, its mode and auto-advance read. The journal reader must keep
 * them all: ed-mcp keeps some, and HUD_EVENTS asks for the rest. A test checks it.
 */
export const TRADE_EVENTS = [
  "MarketBuy",
  "MarketSell",
  "Docked",
  "Undocked",
  "FSDJump",
  "CarrierJump",
  // Traded cargo that leaves without a sale.
  "CargoTransfer",
  "EjectCargo",
  "LoadGame",
  "Shutdown",
  "Died",
  // A game restarted while docked starts with Location, Docked true.
  "Location",
  // Mission cargo aboard, goods a mission asks for, and colonisation: a market buy for one of
  // them is not a trade (tradeBuys()).
  "MissionAccepted",
  "MissionCompleted",
  "MissionFailed",
  "MissionAbandoned",
  "CargoDepot",
  "ColonisationContribution",
  "ColonisationConstructionDepot",
] as const;

/**
 * A commodity's key for matching the plan, the hold, the market and the journal. The plan has
 * the English names Spansh gives; ed-mcp's cargo, MarketBuy's Type_Localised and Market.json's
 * Name_Localised have the game's names, which on an English client are the same: "Agri-Medicines",
 * where the internal name is "agriculturalmedicines". So the game's name is used when the journal
 * gives one, else the internal name, which for most goods is the English name in lower case. On a
 * non-English client the game's names do not match the plan's: a known limit, as for mining.
 */
const keyOf = (internal: unknown, localised: unknown) =>
  commodityKey(str(localised) ?? str(internal) ?? "");

// ---------- The market ----------

export interface MarketItem {
  /** What the market sells it for, and buys it for; 0 when it does not. */
  buy: number;
  sell: number;
}

/** Market.json: the market of the station whose commodity screen was opened last. */
export interface Market {
  marketId: number;
  station: string;
  /** By commodityKey(). */
  items: Map<string, MarketItem>;
}

export function parseMarket(text: string): Market | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const marketId = num(j.MarketID);
    const station = str(j.StationName);
    if (marketId === null || station === null) return null;
    const items = new Map<string, MarketItem>();
    for (const i of objs(j.Items)) {
      const key = keyOf(i.Name, i.Name_Localised);
      if (!key) continue;
      items.set(key, { buy: num(i.BuyPrice) ?? 0, sell: num(i.SellPrice) ?? 0 });
    }
    return { marketId, station, items };
  } catch {
    return null;
  }
}

// ---------- The journal's trades ----------

/** What the hold and the missions are now, for judging the journal's older market buys. */
export interface MissionsNow {
  /** Mission cargo in the hold now: its mission and commodity. */
  missionCargo: { id: number; commodity: string }[];
  /** Open missions asking for goods (source and collect missions): their ID and commodity. */
  wanted: { id: number; commodity: string }[];
}

export const NO_MISSIONS: MissionsNow = { missionCargo: [], wanted: [] };

/** MissionsNow from ed-mcp's journal state. */
export function missionsNow(j: Pick<JournalState, "cargo" | "missions">): MissionsNow {
  return {
    missionCargo: j.cargo.flatMap((c) =>
      c.mission_id !== null ? [{ id: c.mission_id, commodity: c.name }] : [],
    ),
    // Source and collect missions: goods to bring back, so buying them is not a trade.
    wanted: j.missions.flatMap((m) =>
      m.commodity && m.destination_system === null && m.kill_count === null
        ? [{ id: m.id, commodity: m.commodity }]
        : [],
    ),
  };
}

const commodityOf = (e: JournalEvent) => keyOf(e.Type, e.Type_Localised);

/** Every key a commodity goes by in an event: its internal and its game name. */
const keysOf = (...names: unknown[]) =>
  names.filter((x): x is string => typeof x === "string" && x !== "").map(commodityKey);

/** Docking: a Docked event, or a game restarted while docked. */
export const isDocking = (e: JournalEvent) =>
  e.event === "Docked" || (e.event === "Location" && e.Docked === true);

/** A colonisation depot supplied this recently makes a market buy a delivery to it. */
const COLONY_MS = 2 * 3_600_000;

const isMassacreAccepted = (e: JournalEvent) => typeof e.KillCount === "number";

/** A market buy of something to trade: not limpets. */
export const tradeBuy = (e: JournalEvent) => e.event === "MarketBuy" && commodityOf(e) !== "drones";

/**
 * The market buys in events that are trade: not limpets, not of goods a mission has aboard or
 * asks for, and not while supplying a colonisation depot.
 *
 * A delivery's goods are aboard from its acceptance, or for a depot or wing delivery (whose goods
 * come from a depot) from its CargoDepot Collect, until the mission ends, its goods are all
 * delivered, or it expires (a mission that expired with the game off never ends in the journal).
 * A source or collect mission asks for its goods from its acceptance. Missions taken before the
 * journal's window count all along, from the hold and the missions now.
 */
export function tradeBuys(events: JournalEvent[], now: MissionsNow): Set<JournalEvent> {
  const id = (e: JournalEvent) => num(e.MissionID);
  const accepted = new Set(events.filter((e) => e.event === "MissionAccepted").map(id));
  const fromDepot = new Set(events.filter((e) => e.event === "CargoDepot").map(id));
  // The goods each mission has aboard or asks for, until it expires: a buy of them is for it.
  type Goods = { keys: string[]; expires: number };
  const blocked = new Map<number, Goods>();
  for (const m of [...now.missionCargo, ...now.wanted]) {
    if (accepted.has(m.id)) continue;
    const keys = blocked.get(m.id)?.keys ?? [];
    blocked.set(m.id, { keys: [...keys, commodityKey(m.commodity)], expires: Infinity });
  }
  // Depot and wing deliveries, whose goods are not aboard until collected.
  const pending = new Map<number, Goods>();
  let colony = -Infinity;
  const out = new Set<JournalEvent>();
  let last = 0;
  for (const e of events) {
    last = Date.parse(e.timestamp) || last;
    const m = id(e);
    switch (e.event) {
      case "MissionAccepted": {
        if (m === null || typeof e.Commodity !== "string" || isMassacreAccepted(e)) break;
        if (typeof e.PassengerCount === "number") break;
        const goods = {
          keys: keysOf(e.Commodity, e.Commodity_Localised),
          expires: Date.parse(String(e.Expiry)) || Infinity,
        };
        const depot =
          typeof e.DestinationSystem === "string" &&
          (fromDepot.has(m) || /wing/i.test(String(e.Name ?? "")));
        (depot ? pending : blocked).set(m, goods);
        break;
      }
      case "CargoDepot":
        if (m === null) break;
        if (e.UpdateType === "Collect") {
          const goods = pending.get(m) ?? {
            keys: keysOf(e.CargoType, e.CargoType_Localised),
            expires: Infinity,
          };
          blocked.set(m, goods);
        }
        if (
          e.UpdateType === "Deliver" &&
          typeof e.TotalItemsToDeliver === "number" &&
          num(e.ItemsDelivered)! >= e.TotalItemsToDeliver
        )
          blocked.delete(m);
        break;
      case "MissionCompleted":
      case "MissionFailed":
      case "MissionAbandoned":
        if (m === null) break;
        blocked.delete(m);
        pending.delete(m);
        break;
      case "ColonisationContribution":
        colony = last;
        break;
      case "ColonisationConstructionDepot":
        // Written whenever the depot screen opens, so it only ends the window: once built.
        if (e.ConstructionComplete === true || e.ConstructionFailed === true) colony = -Infinity;
        break;
      case "MarketBuy": {
        if (!tradeBuy(e)) break;
        const keys = keysOf(e.Type, e.Type_Localised);
        const forMission = [...blocked.values()].some(
          (b) => b.expires > last && b.keys.some((k) => keys.includes(k)),
        );
        if (!forMission && last - colony > COLONY_MS) out.add(e);
        break;
      }
    }
  }
  return out;
}

/** The journal's trading, replayed once for each read of the journal. */
export interface TradeJournal {
  /** The market buys that are trade (tradeBuys()). */
  buys: Set<JournalEvent>;
  /** The sales of traded cargo: of tons with a known cost. */
  sales: Set<JournalEvent>;
  /** Tons bought as trade and not yet sold or gone, by commodity key. */
  tons: Map<string, number>;
  clock: ActiveClock;
  earned: { at: number; credits: number }[];
  /** Trade buys and sales this game session. */
  trades: number;
}

const journals = new WeakMap<
  JournalEvent[],
  { length: number; now: string; journal: TradeJournal }
>();

/**
 * The trading in events, kept for the same events and missions: the panel and its mode ask on
 * every render, more often than the journal grows.
 */
export function tradeJournal(events: JournalEvent[], now: MissionsNow = NO_MISSIONS): TradeJournal {
  // Only what tradeBuys() reads: callers pass MissionsNow inside larger objects.
  const key = JSON.stringify([now.missionCargo, now.wanted]);
  const kept = journals.get(events);
  if (kept && kept.length === events.length && kept.now === key) return kept.journal;
  const journal = replay(events, tradeBuys(events, now));
  journals.set(events, { length: events.length, now: key, journal });
  return journal;
}

/**
 * The cost of traded cargo and the session's profit. A sale's tons cost the average paid for that
 * commodity in the trade buys before it (kept over a relog, since the cargo is); more tons of a
 * traded commodity, bought before the journal's window, cost the sale's AvgPricePaid. A sale with
 * no trade-bought tons, such as mined cargo or a mission's reward, is not trade and counts nothing. Tons that leave without a sale (given to a
 * depot or a mission, moved to the carrier, ejected) leave the cost too. The clock runs from the
 * session's first trade, as the exploration rate's does from its first scan.
 */
function replay(events: JournalEvent[], buys: Set<JournalEvent>): TradeJournal {
  // Tons bought and what they cost, by commodity: under each of its names (internal and the
  // game's), since CargoTransfer and EjectCargo give only the internal one.
  const basis = new Map<string, { tons: number; cost: number }>();
  const take = (keys: string[], count: number) => {
    const b = keys.map((k) => basis.get(k)).find(Boolean);
    const n = Math.min(count, b?.tons ?? 0);
    if (!b || n <= 0) return { n: 0, cost: 0 };
    const cost = (b.cost / b.tons) * n;
    b.tons -= n;
    b.cost -= cost;
    return { n, cost };
  };
  const sales = new Set<JournalEvent>();
  let clock = new ActiveClock();
  let earned: { at: number; credits: number }[] = [];
  let trades = 0;
  for (const e of events) {
    const at = Date.parse(e.timestamp);
    if (!Number.isNaN(at)) clock.tick(at);
    switch (e.event) {
      case "LoadGame":
        clock = new ActiveClock();
        earned = [];
        trades = 0;
        break;
      case "Shutdown":
        if (!Number.isNaN(at)) clock.stop(at);
        break;
      case "Died":
        basis.clear();
        break;
      case "MarketBuy": {
        const count = num(e.Count) ?? 0;
        if (count <= 0 || !buys.has(e)) break;
        const keys = keysOf(e.Type, e.Type_Localised);
        const b = keys.map((k) => basis.get(k)).find(Boolean) ?? { tons: 0, cost: 0 };
        b.tons += count;
        b.cost += num(e.TotalCost) ?? count * (num(e.BuyPrice) ?? 0);
        for (const k of keys) basis.set(k, b);
        trades++;
        if (!Number.isNaN(at)) clock.start(at);
        break;
      }
      case "MarketSell": {
        const count = num(e.Count) ?? 0;
        if (count <= 0) break;
        const price = (num(e.TotalSale) ?? count * (num(e.SellPrice) ?? 0)) / count;
        const known = take(keysOf(e.Type, e.Type_Localised), count);
        // Only a sale of cargo bought as trade is a trade: not a mission's reward, stolen goods or
        // mined ore, whatever the game says was paid for them.
        if (!known.n) break;
        let profit = price * known.n - known.cost;
        // The rest of a traded commodity was bought before the journal's window: the game's price.
        const paid = num(e.AvgPricePaid) ?? 0;
        if (count > known.n && paid > 0) profit += (price - paid) * (count - known.n);
        sales.add(e);
        trades++;
        if (!Number.isNaN(at)) {
          clock.start(at);
          earned.push({ at, credits: profit });
        }
        break;
      }
      // Cargo that leaves without a sale.
      case "ColonisationContribution":
        for (const c of objs(e.Contributions))
          take(keysOf(c.Name, c.Name_Localised), num(c.Amount) ?? 0);
        break;
      case "MissionCompleted":
        // A source or collect mission takes its goods; a delivery's were the mission's own.
        if (typeof e.DestinationSystem !== "string")
          take(keysOf(e.Commodity, e.Commodity_Localised), num(e.Count) ?? 0);
        break;
      case "CargoTransfer":
        for (const t of objs(e.Transfers)) {
          if (t.Direction !== "toship") take(keysOf(t.Type, t.Type_Localised), num(t.Count) ?? 0);
        }
        break;
      case "EjectCargo":
        if (num(e.MissionID) === null) take(keysOf(e.Type, e.Type_Localised), num(e.Count) ?? 0);
        break;
    }
  }
  const tons = new Map([...basis].filter(([, b]) => b.tons > 0).map(([k, b]) => [k, b.tons]));
  return { buys, sales, tons, clock, earned, trades };
}

// ---------- Profit ----------

export interface TradeTotals {
  /** This game session's profit: each sale less what its tons cost. */
  profit: number;
  /** Market buys and sales this game session. */
  trades: number;
  /** Time counted on the session's clock, from its first trade. */
  active: number;
  rate: Rates;
}

/** This game session's trade profit, and its credits an hour (see replay()). */
export function tradeTotals(
  events: JournalEvent[],
  now: number,
  missions: MissionsNow = NO_MISSIONS,
): TradeTotals {
  const j = tradeJournal(events, missions);
  return {
    profit: j.earned.reduce((n, x) => n + x.credits, 0),
    trades: j.trades,
    active: j.clock.total(now),
    rate: rates(j.clock, j.earned, now),
  };
}

// ---------- The plan ----------

/**
 * Whether docking at a station is at this stop. A stop with no station (one made by hand) stands
 * for every station in its system.
 */
export const stopAt = (s: { system: string; station?: string }, system: string, station: string) =>
  same(s.system, system) && (!s.station || same(s.station, station));

/** A plan with a trade stop: the trade panel shows it. */
export const isTradePlan = (plan: Plan | null | undefined): plan is Plan =>
  !!plan && plan.stops.some((s) => s.kind === "trade");

/** The trade stops still to do, as plan.stops indexes in visit order: the current one first. */
export function tradeTodo(plan: Plan | null | undefined): number[] {
  if (!plan) return [];
  return visitOrder(plan).filter((i) => {
    const s = plan.stops[i]!;
    return s.kind === "trade" && s.status === "todo";
  });
}

/**
 * What to do at a stop: its cargo, sales first. On a loop's first lap the first stop has nothing
 * to sell yet (its sale is of what the last stop buys), so only its buys are left.
 */
export function stopCargo(plan: Plan, index: number): Cargo[] {
  const cargo = plan.stops[index]?.cargo ?? [];
  const firstLap = plan.repeat === true && (plan.lap ?? 1) === 1;
  if (firstLap && visitOrder(plan)[0] === index) return cargo.filter((c) => c.action === "buy");
  return cargo;
}

/**
 * Where the ship is docked now, from the newest Docked event, or the Location a game restarted
 * while docked starts with; null when it is not docked.
 */
export interface Dock {
  system: string;
  station: string;
  marketId: number | null;
  /** The Docked (or Location) event's index in events, and its time. */
  index: number;
  at: string;
}

export function dockedAt(events: JournalEvent[], location: JournalState["location"]): Dock | null {
  if (!location.docked || !location.station) return null;
  let index = events.findLastIndex(isDocking);
  // A relog while docked writes Location, Docked true: the same visit as the docking before it
  // at that station, with no undocking between, so trades made before the relog still count.
  while (events[index]?.event === "Location") {
    const at = index;
    const before = events.findLastIndex(
      (x, k) => k < at && (isDocking(x) || x.event === "Undocked"),
    );
    const b = events[before];
    if (!b || b.event === "Undocked" || !same(str(b.StationName), str(events[at]!.StationName)))
      break;
    index = before;
  }
  const e = events[index];
  if (!e || !same(str(e.StationName), location.station)) return null;
  return {
    system: str(e.StarSystem) ?? location.system ?? "",
    station: location.station,
    marketId: num(e.MarketID),
    index,
    at: e.timestamp,
  };
}

const atStop = (s: Stop, dock: Dock | null) =>
  dock !== null && stopAt(s, dock.system, dock.station);

/** Cargo the ship may trade: not limpets, not a mission's, not stolen (a black market's). */
const tradable = (c: JournalState["cargo"][number]) =>
  c.count > 0 && c.mission_id === null && !c.stolen && commodityKey(c.name) !== "drones";

/** Tons of a commodity aboard that the ship may trade. */
function held(cargo: JournalState["cargo"], commodity: string): number {
  const key = commodityKey(commodity);
  return cargo
    .filter((c) => tradable(c) && commodityKey(c.name) === key)
    .reduce((n, c) => n + c.count, 0);
}

/** Cargo aboard that was bought as trade (the replay's tons): not mined ore or salvage. */
const traded = (c: JournalState["cargo"][number], journal: TradeJournal) =>
  tradable(c) && (journal.tons.get(commodityKey(c.name)) ?? 0) > 0;

/** Whether the hold has cargo bought as trade and not yet sold or gone. */
export function tradeCargo(cargo: JournalState["cargo"], journal: TradeJournal): boolean {
  return cargo.some((c) => traded(c, journal));
}

interface Hold {
  cargo: JournalState["cargo"];
  capacity: number | null;
}

/**
 * Whether one of a stop's actions is done while docked there: a buy once it was bought here and
 * the hold has the planned tons (or is full); a sale once it was sold here and none is left
 * aboard. Cargo brought from an earlier stop or lap does not count as bought here.
 */
function actionDone(c: Cargo, hold: Hold, events: JournalEvent[], dock: Dock): boolean {
  const key = commodityKey(c.commodity);
  const aboard = held(hold.cargo, c.commodity);
  const here = events
    .slice(dock.index + 1)
    .filter(
      (e) =>
        (dock.marketId === null || num(e.MarketID) === null || num(e.MarketID) === dock.marketId) &&
        commodityOf(e) === key,
    );
  if (c.action === "sell") return aboard === 0 && here.some((e) => e.event === "MarketSell");
  if (!here.some((e) => e.event === "MarketBuy") || aboard === 0) return false;
  const used = hold.cargo.reduce((n, x) => n + x.count, 0);
  return aboard >= c.amount || (hold.capacity !== null && used >= hold.capacity);
}

/**
 * The trade stop to mark done now, if any: the plan's current stop, a trade stop, docked there, with every
 * action done (a stop with nothing to buy or sell is done on docking). `key` names this stop,
 * lap and docking, so it is marked once. Undocking first leaves the stop open: it is only judged
 * while docked.
 */
export function tradeAdvance(input: {
  plan: Plan | null;
  events: JournalEvent[];
  cargo: JournalState["cargo"];
  capacity: number | null;
  location: JournalState["location"];
}): { index: number; key: string } | null {
  const plan = input.plan;
  // The plan's current stop, as the route rows and keys have it, when it is a trade stop.
  const index = plan ? currentStop(plan) : null;
  if (!plan || index === null || plan.stops[index]!.kind !== "trade") return null;
  const dock = dockedAt(input.events, input.location);
  if (!dock || !atStop(plan.stops[index]!, dock)) return null;
  const hold = { cargo: input.cargo, capacity: input.capacity };
  if (!stopCargo(plan, index).every((c) => actionDone(c, hold, input.events, dock))) return null;
  return { index, key: `${plan.id}|${plan.lap ?? 1}|${index}|${dock.at}` };
}

/** After a stop is marked done: the next stop's system to copy, when it is in another system. */
export function tradeNextCopy(plan: Plan, here: string | null): string | null {
  const i = currentStop(plan);
  const system = i === null ? null : plan.stops[i]!.system;
  return system && !same(system, here) ? system : null;
}

// ---------- The panel ----------

const price = (n: number) => Math.round(n).toLocaleString("en-US");
const place = (s: Stop) => (s.station ? `${s.system} · ${s.station}` : s.system);
const actionText = (c: Cargo) => `${c.action.toUpperCase()} ${c.amount} t ${c.commodity}`;
const actionsText = (cargo: Cargo[]) =>
  cargo.length ? cargo.map(actionText).join(" · ") : "pass through";

/** A live price this much worse than the plan's shows in amber. */
const PRICE_SLIP = 0.05;
/** Older market data than this shows its age in the header. */
const PRICES_OLD_MS = 24 * 3_600_000;

/** "Loop: A ⇄ B" for ed-mcp's "Trade loop: A ⇄ B", and the same for a route. */
export function planTitle(name: string): string {
  return name.replace(/^trade loop:\s*/i, "Loop: ").replace(/^trade route:\s*/i, "Route: ");
}

function pricesAge(plan: Plan, now: number): string | null {
  const at = plan.prices_at ? Date.parse(plan.prices_at) : NaN;
  if (Number.isNaN(at) || now - at <= PRICES_OLD_MS) return null;
  const h = Math.floor((now - at) / 3_600_000);
  return h < 72 ? `prices ${h}h old` : `prices ${Math.floor(h / 24)}d old`;
}

/**
 * The hold against the plan's tons, and the market's price against the planned one while docked
 * at the stop and its market is known: "hold 0/720 · price 9,410 (plan 9,380)".
 */
function status(
  c: Cargo,
  hold: Hold,
  market: Market | null,
  done: boolean,
): { text: string; tone?: Tone } {
  const parts = [`hold ${held(hold.cargo, c.commodity)}/${c.amount}`];
  const item = market?.items.get(commodityKey(c.commodity));
  const live = item ? (c.action === "buy" ? item.buy : item.sell) : 0;
  let tone: Tone | undefined = done ? "good" : undefined;
  if (live > 0) {
    parts.push(`price ${price(live)}${c.price ? ` (plan ${price(c.price)})` : ""}`);
    const worse = c.action === "buy" ? live - (c.price ?? live) : (c.price ?? live) - live;
    if (!done && c.price && worse > c.price * PRICE_SLIP) tone = "warn";
  } else if (c.price) parts.push(`plan ${price(c.price)}`);
  return { text: parts.join(" · "), tone };
}

export function tradePanel(input: {
  plan: Plan | null;
  events: JournalEvent[];
  cargo: JournalState["cargo"];
  capacity: number | null;
  location: JournalState["location"];
  /** Market.json, as last read. */
  market: Market | null;
  missions: Mission[];
  now: number;
  /** The hold's mission cargo and the goods missions ask for: see tradeBuys(). */
  missionsNow?: MissionsNow;
  /** The plotted route, for the jumps left to the stop it leads to. */
  nav?: NavRoute | null;
}): PanelView | null {
  const plan = isTradePlan(input.plan) ? input.plan : null;
  const todo = tradeTodo(plan);
  const hold = { cargo: input.cargo, capacity: input.capacity };
  const journal = tradeJournal(input.events, input.missionsNow);
  if (!todo.length && !tradeCargo(input.cargo, journal)) return null;
  const dock = dockedAt(input.events, input.location);
  const rows: HudRow[] = [];
  if (plan && todo.length) {
    const cur = plan.stops[todo[0]!]!;
    // The jumps left on the plotted route, on the row of the stop it leads to: the next stop
    // when the route ends in its system, else the current one, as the route rows show them.
    const nav = input.nav ?? null;
    const jumps = jumpsLeft(nav, input.location.system);
    const jumpText = jumps !== null ? `${jumps} jump${jumps === 1 ? "" : "s"}` : null;
    const nextStop = todo[1] !== undefined ? plan.stops[todo[1]]! : null;
    const toNext =
      jumpText !== null &&
      nextStop !== null &&
      same(nav!.systems.at(-1), nextStop.system) &&
      !same(nextStop.system, cur.system);
    const withJumps = (right: string | undefined, on: boolean) =>
      on && jumpText ? [right, jumpText].filter(Boolean).join(" · ") : right;
    const cargo = stopCargo(plan, todo[0]!);
    const here = atStop(cur, dock) ? dock : null;
    // The market only of this station: Market.json is of the last market screen opened.
    const market =
      here && input.market && input.market.marketId === here.marketId ? input.market : null;
    const line = (c: Cargo) =>
      status(c, hold, market, here !== null && actionDone(c, hold, input.events, here));
    if (cargo.length === 1) {
      const s = line(cargo[0]!);
      rows.push({ text: `● ${place(cur)}`, right: withJumps(actionText(cargo[0]!), !toNext) });
      rows.push({ text: `  ${s.text}`, tone: s.tone });
    } else if (cargo.length) {
      const right = withJumps(undefined, !toNext);
      rows.push(right ? { text: `● ${place(cur)}`, right } : { text: `● ${place(cur)}` });
      for (const c of cargo) {
        const s = line(c);
        rows.push({ text: `  ${actionText(c)}`, right: s.text, tone: s.tone });
      }
    } else rows.push({ text: `● ${place(cur)}`, right: withJumps("pass through", !toNext) });
    const next = todo[1];
    if (next !== undefined) {
      rows.push({
        text: `▸ ${place(plan.stops[next]!)}`,
        right: withJumps(actionsText(stopCargo(plan, next)), toNext),
        tone: "dim",
      });
    }
  } else {
    // Bought with no plan, or the plan is done: what is aboard.
    for (const c of input.cargo) {
      if (!traded(c, journal)) continue;
      rows.push({ text: c.name, right: `${c.count} t` });
    }
    rows.push({
      text: plan ? "Trade route done" : "No trade plan: ask Claude for a trade loop or route",
      tone: "dim",
    });
  }

  const totals = tradeTotals(input.events, input.now, input.missionsNow);
  const footer: string[] = [];
  if (totals.trades) {
    footer.push(
      `Session: ${[
        `${credits(totals.profit)} profit`,
        totals.active >= 60_000 ? timeLeft(totals.active) : "0m",
        rateText(totals.rate),
      ]
        .filter(Boolean)
        .join(" · ")}`,
    );
  }
  // Passengers taken on a trade run show here, not as their own panel.
  const runs = input.missions.filter(isRun);
  if (runs.length) {
    const pax = runs.reduce((n, m) => n + (m.passengers ?? 0), 0);
    const n = `${runs.length} mission${runs.length === 1 ? "" : "s"}`;
    footer.push(pax ? `Passengers: ${pax} aboard · ${n}` : `Deliveries: ${n}`);
  }
  // How far through the plan: the current stop's place among all its stops in visit order (which
  // follows a saved route), as the plan's own count says ("3 stops"). The rate is on the Session
  // line.
  const order = plan ? visitOrder(plan) : [];
  const stops = order.length;
  const at = todo.length ? order.indexOf(todo[0]!) + 1 : null;
  return {
    mode: "trade",
    title: "TRADE",
    subtitle: plan ? planTitle(plan.name) : undefined,
    right:
      [
        at !== null && stops > 1 ? `stop ${at}/${stops}` : null,
        plan?.repeat ? `lap ${plan.lap ?? 1}` : null,
        plan ? pricesAge(plan, input.now) : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    rows,
    footer,
  };
}
