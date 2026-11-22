import {
  visitOrder,
  type JournalEvent,
  type JournalState,
  type Mission,
  type Plan,
} from "ed-mcp/journal";
import { num, objs, str } from "./json.js";
import { commodityKey } from "./mining.js";
import { isRun } from "./passenger.js";
import {
  credits,
  hourly,
  rateText,
  timeLeft,
  type HudRow,
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
  "LoadGame",
  "Shutdown",
  "Died",
  // Mission cargo aboard, which makes a market buy not a trade.
  "MissionAccepted",
  "MissionCompleted",
  "MissionFailed",
  "MissionAbandoned",
] as const;

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
      const name = str(i.Name) ?? str(i.Name_Localised);
      if (!name) continue;
      items.set(commodityKey(name), { buy: num(i.BuyPrice) ?? 0, sell: num(i.SellPrice) ?? 0 });
    }
    return { marketId, station, items };
  } catch {
    return null;
  }
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

const commodityOf = (e: JournalEvent) => commodityKey(str(e.Type) ?? str(e.Type_Localised) ?? "");

/**
 * This game session's trade profit, and its credits an hour. A sale's tons cost the average paid
 * for that commodity in the MarketBuys before it (kept over a relog, since the cargo is); tons
 * bought before the journal's window cost the sale's AvgPricePaid. Tons with no cost, such as
 * mined cargo or a mission's reward, are not trade and count nothing. The clock runs from the
 * session's first trade, as the exploration rate's does from its first scan.
 */
export function tradeTotals(events: JournalEvent[], now: number): TradeTotals {
  // The replay is kept for the same events: the panel renders more often than the journal grows.
  let r = replays.get(events);
  if (!r || r.length !== events.length) {
    r = { length: events.length, ...replay(events) };
    replays.set(events, r);
  }
  return {
    profit: r.earned.reduce((n, x) => n + x.credits, 0),
    trades: r.trades,
    active: r.clock.total(now),
    rate: rates(r.clock, r.earned, now),
  };
}

interface Replay {
  clock: ActiveClock;
  earned: { at: number; credits: number }[];
  trades: number;
}

const replays = new WeakMap<JournalEvent[], Replay & { length: number }>();

function replay(events: JournalEvent[]): Replay {
  // Tons bought and what they cost, by commodity.
  const basis = new Map<string, { tons: number; cost: number }>();
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
        // Limpets are not trade.
        if (count <= 0 || !tradeBuy(e)) break;
        const key = commodityOf(e);
        const b = basis.get(key) ?? { tons: 0, cost: 0 };
        b.tons += count;
        b.cost += num(e.TotalCost) ?? count * (num(e.BuyPrice) ?? 0);
        basis.set(key, b);
        trades++;
        if (!Number.isNaN(at)) clock.start(at);
        break;
      }
      case "MarketSell": {
        const count = num(e.Count) ?? 0;
        if (count <= 0) break;
        const key = commodityOf(e);
        const price = (num(e.TotalSale) ?? count * (num(e.SellPrice) ?? 0)) / count;
        const b = basis.get(key);
        const known = Math.min(count, b?.tons ?? 0);
        let profit = 0;
        let costed = 0;
        if (b && known > 0) {
          const cost = (b.cost / b.tons) * known;
          profit += price * known - cost;
          b.tons -= known;
          b.cost -= cost;
          costed += known;
        }
        const paid = num(e.AvgPricePaid) ?? 0;
        if (count > known && paid > 0) {
          profit += (price - paid) * (count - known);
          costed += count - known;
        }
        // Only a sale of cargo that was bought is a trade.
        if (!costed) break;
        trades++;
        if (!Number.isNaN(at)) {
          clock.start(at);
          earned.push({ at, credits: profit });
        }
        break;
      }
    }
  }
  return { clock, earned, trades };
}

// ---------- The plan ----------

/** Names of one place, whatever their case. */
export const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Whether docking at a station is at this stop. A stop with no station (one made by hand) stands
 * for every station in its system.
 */
export const stopAt = (s: { system: string; station?: string }, system: string, station: string) =>
  same(s.system, system) && (!s.station || same(s.station, station));

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

/** Where the ship is docked now, from the newest Docked event; null when it is not docked. */
export interface Dock {
  system: string;
  station: string;
  marketId: number | null;
  /** The Docked event's index in events, and its time. */
  index: number;
  at: string;
}

export function dockedAt(events: JournalEvent[], location: JournalState["location"]): Dock | null {
  if (!location.docked || !location.station) return null;
  const index = events.findLastIndex((e) => e.event === "Docked");
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

/** A market buy of something to trade: not limpets. */
export const tradeBuy = (e: JournalEvent) => e.event === "MarketBuy" && commodityOf(e) !== "drones";

/** Tons of a commodity aboard that the ship may trade. */
function held(cargo: JournalState["cargo"], commodity: string): number {
  const key = commodityKey(commodity);
  return cargo
    .filter((c) => tradable(c) && commodityKey(c.name) === key)
    .reduce((n, c) => n + c.count, 0);
}

/** Whether the hold has cargo the ship could trade. */
export function tradeCargo(cargo: JournalState["cargo"]): boolean {
  return cargo.some(tradable);
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
 * The trade stop to mark done now, if any: the current trade stop, docked there, with every
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
  const index = tradeTodo(plan)[0];
  if (!plan || index === undefined) return null;
  const dock = dockedAt(input.events, input.location);
  if (!dock || !atStop(plan.stops[index]!, dock)) return null;
  const hold = { cargo: input.cargo, capacity: input.capacity };
  if (!stopCargo(plan, index).every((c) => actionDone(c, hold, input.events, dock))) return null;
  return { index, key: `${plan.id}|${plan.lap ?? 1}|${index}|${dock.at}` };
}

/** After a stop is marked done: the next stop's system to copy, when it is in another system. */
export function tradeNextCopy(plan: Plan, here: string | null): string | null {
  const order = visitOrder(plan);
  const i = order.find((j) => plan.stops[j]!.status === "todo");
  const system = i === undefined ? null : plan.stops[i]!.system;
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
}): PanelView | null {
  const plan = input.plan?.stops.some((s) => s.kind === "trade") ? input.plan : null;
  const todo = tradeTodo(plan);
  const hold = { cargo: input.cargo, capacity: input.capacity };
  if (!todo.length && !tradeCargo(input.cargo)) return null;
  const dock = dockedAt(input.events, input.location);
  const rows: HudRow[] = [];
  if (plan && todo.length) {
    const cur = plan.stops[todo[0]!]!;
    const cargo = stopCargo(plan, todo[0]!);
    const here = atStop(cur, dock) ? dock : null;
    // The market only of this station: Market.json is of the last market screen opened.
    const market =
      here && input.market && input.market.marketId === here.marketId ? input.market : null;
    const line = (c: Cargo) =>
      status(c, hold, market, here !== null && actionDone(c, hold, input.events, here));
    if (cargo.length === 1) {
      const s = line(cargo[0]!);
      rows.push({ text: `● ${place(cur)}`, right: actionText(cargo[0]!) });
      rows.push({ text: `  ${s.text}`, tone: s.tone });
    } else if (cargo.length) {
      rows.push({ text: `● ${place(cur)}` });
      for (const c of cargo) {
        const s = line(c);
        rows.push({ text: `  ${actionText(c)}`, right: s.text, tone: s.tone });
      }
    } else rows.push({ text: `● ${place(cur)}`, right: "pass through" });
    const next = todo[1];
    if (next !== undefined) {
      rows.push({
        text: `▸ ${place(plan.stops[next]!)}`,
        right: actionsText(stopCargo(plan, next)),
        tone: "dim",
      });
    }
  } else {
    // Bought with no plan, or the plan is done: what is aboard.
    for (const c of input.cargo) {
      if (!tradable(c)) continue;
      rows.push({ text: c.name, right: `${c.count} t` });
    }
    rows.push({
      text: plan ? "Trade route done" : "No trade plan: ask Claude for a trade loop or route",
      tone: "dim",
    });
  }

  const totals = tradeTotals(input.events, input.now);
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
  const rate = totals.rate.session;
  return {
    mode: "trade",
    title: "TRADE",
    subtitle: plan ? planTitle(plan.name) : undefined,
    right:
      [
        plan?.repeat ? `lap ${plan.lap ?? 1}` : null,
        plan ? pricesAge(plan, input.now) : null,
        hourly(rate),
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    rows,
    footer,
  };
}
