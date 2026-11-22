import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalState, Mission, Plan } from "ed-mcp/journal";
import { buildHud, currentMode, type HudInput } from "../src/core/hud/hud.js";
import {
  HUD_EVENTS,
  journalMode,
  LAPSE_JUMPS,
  noteMode,
  type TradeNow,
} from "../src/core/hud/mode.js";
import {
  dockedAt,
  parseMarket,
  planTitle,
  stopCargo,
  tradeAdvance,
  TRADE_EVENTS,
  tradeNextCopy,
  tradePanel,
  tradeTodo,
  tradeTotals,
} from "../src/core/hud/trade.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const MIN = 60_000;
/** An event `m` minutes before NOW. */
const at = (m: number, event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: new Date(NOW - m * MIN).toISOString(),
  event,
  ...extra,
});
const buy = (m: number, type: string, count: number, price: number, market = 1) =>
  at(m, "MarketBuy", {
    MarketID: market,
    Type: type.toLowerCase(),
    Type_Localised: type,
    Count: count,
    BuyPrice: price,
    TotalCost: count * price,
  });
const sell = (m: number, type: string, count: number, price: number, extra = {}, market = 2) =>
  at(m, "MarketSell", {
    MarketID: market,
    Type: type.toLowerCase(),
    Type_Localised: type,
    Count: count,
    SellPrice: price,
    TotalSale: count * price,
    ...extra,
  });
const docked = (m: number, system: string, station: string, market: number) =>
  at(m, "Docked", { StarSystem: system, StationName: station, MarketID: market });

type Cargo = JournalState["cargo"];
const hold = (o: Record<string, number>, mission: number | null = null): Cargo =>
  Object.entries(o).map(([name, count]) => ({ name, count, stolen: false, mission_id: mission }));

const where = (system: string, station: string | null): JournalState["location"] => ({
  system,
  station,
  station_type: null,
  docked: station !== null,
  dist_from_star_ls: null,
});

const stop = (
  system: string,
  station: string,
  cargo: { commodity: string; action: "buy" | "sell"; amount: number; price?: number }[],
  status: "todo" | "done" = "todo",
): Plan["stops"][number] => ({
  system,
  station,
  purpose: `Trade at ${station}`,
  label: `Trade at ${station}`,
  kind: "trade",
  status,
  ...(cargo.length ? { cargo } : {}),
});

/** A two-station loop: buy gold at Wohler Terminal, sell it at Brooks Estate. */
const loop = (o: Partial<Plan> = {}): Plan =>
  ({
    id: "trade",
    name: "Trade loop: Kremainn ⇄ Wolf 397",
    items: [],
    stops: [
      stop("Kremainn", "Wohler Terminal", [
        { commodity: "Silver", action: "sell", amount: 720, price: 4_200 },
        { commodity: "Gold", action: "buy", amount: 720, price: 9_380 },
      ]),
      stop("Wolf 397", "Brooks Estate", [
        { commodity: "Gold", action: "sell", amount: 720, price: 30_000 },
        { commodity: "Silver", action: "buy", amount: 720, price: 3_000 },
      ]),
    ],
    repeat: true,
    lap: 1,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...o,
  }) as Plan;

const route = (stops: Plan["stops"], o: Partial<Plan> = {}): Plan =>
  ({
    id: "trade",
    name: "Trade route: A → C, 3 stops",
    items: [],
    stops,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...o,
  }) as Plan;

const market = (id: number, items: Record<string, [number, number]>) =>
  parseMarket(
    JSON.stringify({
      timestamp: new Date(NOW).toISOString(),
      MarketID: id,
      StationName: "Wohler Terminal",
      StarSystem: "Kremainn",
      Items: Object.entries(items).map(([name, [b, s]]) => ({
        Name: `$${name.toLowerCase()}_name;`,
        Name_Localised: name,
        BuyPrice: b,
        SellPrice: s,
      })),
    }),
  );

describe("the market file", () => {
  it("reads the prices by commodity", () => {
    const m = market(7, { Gold: [9_410, 9_000] })!;
    expect(m.marketId).toBe(7);
    expect(m.items.get("gold")).toEqual({ buy: 9_410, sell: 9_000 });
  });

  it("is null for a file that is not a market", () => {
    expect(parseMarket("{")).toBeNull();
    expect(parseMarket(JSON.stringify({ StationName: "X" }))).toBeNull();
    // An item with no name is skipped; missing prices read as none.
    const m = parseMarket(
      JSON.stringify({ MarketID: 1, StationName: "X", Items: [{}, { Name: "Gold" }] }),
    );
    expect([...m!.items]).toEqual([["gold", { buy: 0, sell: 0 }]]);
  });
});

describe("trade profit", () => {
  it("is each sale less the average cost of its tons, an hour after five minutes", () => {
    const events = [
      at(60, "LoadGame"),
      buy(40, "Gold", 100, 9_000),
      buy(39, "Gold", 100, 11_000),
      // 150 t at 10,000 average: 150 × 20,000 profit.
      sell(20, "Gold", 150, 30_000),
    ];
    const t = tradeTotals(events, NOW);
    expect(t.profit).toBe(3_000_000);
    expect(t.trades).toBe(3);
    // The clock runs from the first trade; gaps count up to 10 minutes: 1 + 10 + 10 (now).
    expect(t.active).toBe(21 * MIN);
    expect(t.rate.session).toBeCloseTo((3_000_000 * 60) / 21);
    // Not longer than half an hour yet.
    expect(t.rate.recent).toBeNull();
  });

  it("has no rate before five minutes", () => {
    const t = tradeTotals([buy(3, "Gold", 1, 1), sell(2, "Gold", 1, 3)], NOW);
    expect(t.profit).toBe(2);
    expect(t.rate.session).toBeNull();
  });

  it("uses the sale's average price paid for tons bought before the journal, and skips mined cargo", () => {
    const events = [
      sell(30, "Gold", 10, 30_000, { AvgPricePaid: 10_000 }),
      sell(29, "Platinum", 10, 200_000, { AvgPricePaid: 0 }),
      // Partly known: 5 t bought here at 1,000, 5 t at the game's 2,000.
      buy(28, "Silver", 5, 1_000),
      sell(27, "Silver", 10, 3_000, { AvgPricePaid: 2_000 }),
      // Neither event's prices nor totals: no cost known, so the sale is not a trade.
      at(26, "MarketSell", { Type: "tea", Count: 5 }),
      at(25, "MarketSell", { Type: "tea", Count: 0 }),
      at(25, "MarketBuy", { Type: "tea", Count: 0 }),
    ];
    const t = tradeTotals(events, NOW);
    expect(t.profit).toBe(200_000 + 10_000 + 5_000);
    expect(t.trades).toBe(3);
  });

  it("starts again each game session, keeps the cost over a relog, and loses it on death", () => {
    const events = [
      buy(100, "Gold", 10, 1_000),
      sell(99, "Gold", 5, 2_000),
      at(98, "Shutdown"),
      at(50, "LoadGame"),
      sell(40, "Gold", 5, 3_000),
      buy(30, "Silver", 5, 1_000),
      at(29, "Died"),
      sell(20, "Silver", 5, 3_000),
    ];
    const t = tradeTotals(events, NOW);
    expect(t.profit).toBe(10_000);
    expect(t.trades).toBe(2);
  });

  it("has a half-hour rate once the session is longer, and shows a loss", () => {
    const events = [
      buy(60, "Gold", 10, 1_000),
      ...Array.from({ length: 11 }, (_, i) => at(55 - i * 5, "Music")),
      sell(0, "Gold", 10, 500),
    ];
    const t = tradeTotals(events, NOW);
    expect(t.profit).toBe(-5_000);
    expect(t.rate.recent).toBeCloseTo(-10_000);
    expect(t.rate.session).toBeCloseTo(-5_000);
  });
});

describe("the trade plan", () => {
  it("lists the trade stops to do in visit order and names the plan", () => {
    const p = route([
      stop("A", "a", [], "done"),
      { system: "X", purpose: "fuel", kind: "fuel", status: "todo" },
      stop("B", "b", []),
      stop("C", "c", []),
    ]);
    expect(tradeTodo(p)).toEqual([2, 3]);
    expect(tradeTodo(null)).toEqual([]);
    expect(planTitle(loop().name)).toBe("Loop: Kremainn ⇄ Wolf 397");
    expect(planTitle(p.name)).toBe("Route: A → C, 3 stops");
    expect(planTitle("My run")).toBe("My run");
  });

  it("has nothing to sell at a loop's first stop on the first lap", () => {
    expect(stopCargo(loop(), 0).map((c) => c.action)).toEqual(["buy"]);
    expect(stopCargo(loop(), 1).map((c) => c.action)).toEqual(["sell", "buy"]);
    expect(stopCargo(loop({ lap: 2 }), 0).map((c) => c.action)).toEqual(["sell", "buy"]);
    expect(stopCargo(route(loop().stops), 0)).toHaveLength(2);
  });

  it("knows where the ship is docked", () => {
    const events = [docked(5, "Kremainn", "Wohler Terminal", 7)];
    expect(dockedAt(events, where("Kremainn", "Wohler Terminal"))).toMatchObject({
      system: "Kremainn",
      station: "Wohler Terminal",
      marketId: 7,
      index: 0,
    });
    expect(dockedAt(events, where("Kremainn", null))).toBeNull();
    expect(dockedAt(events, where("Kremainn", "Elsewhere"))).toBeNull();
    expect(dockedAt([], where("Kremainn", "Wohler Terminal"))).toBeNull();
    // No system in the event: the location's.
    expect(
      dockedAt(
        [at(1, "Docked", { StationName: "Wohler Terminal" })],
        where("K", "Wohler Terminal"),
      ),
    ).toMatchObject({ system: "K", marketId: null });
  });
});

describe("trade auto-advance", () => {
  const here = where("Kremainn", "Wohler Terminal");
  const input = (o: Partial<Parameters<typeof tradeAdvance>[0]> = {}) => ({
    plan: loop(),
    events: [docked(10, "Kremainn", "Wohler Terminal", 7), buy(5, "Gold", 720, 9_400, 7)],
    cargo: hold({ Gold: 720 }),
    capacity: 720,
    location: here,
    ...o,
  });

  it("marks the stop done once the hold has the planned tons", () => {
    const step = tradeAdvance(input());
    expect(step).toEqual({ index: 0, key: `trade|1|0|${new Date(NOW - 10 * MIN).toISOString()}` });
  });

  it("waits while the buy is short, and leaves the stop open after undocking", () => {
    expect(tradeAdvance(input({ cargo: hold({ Gold: 300 }) }))).toBeNull();
    expect(tradeAdvance(input({ location: where("Kremainn", null) }))).toBeNull();
    // Docked somewhere else.
    expect(
      tradeAdvance(
        input({
          events: [docked(1, "Kremainn", "Other", 8)],
          location: where("Kremainn", "Other"),
        }),
      ),
    ).toBeNull();
    expect(tradeAdvance(input({ plan: null }))).toBeNull();
    expect(
      tradeAdvance(
        input({
          plan: loop({ stops: loop().stops.map((s) => ({ ...s, status: "done" as const })) }),
        }),
      ),
    ).toBeNull();
  });

  it("counts a full hold as bought when the plan asks for more than fits", () => {
    expect(tradeAdvance(input({ cargo: hold({ Gold: 700 }), capacity: 700 }))).not.toBeNull();
    // Full, but not with gold bought here.
    expect(
      tradeAdvance(
        input({
          cargo: hold({ Gold: 700 }),
          capacity: 700,
          events: [buy(20, "Gold", 700, 1), docked(10, "Kremainn", "Wohler Terminal", 7)],
        }),
      ),
    ).toBeNull();
    expect(tradeAdvance(input({ cargo: hold({ Gold: 700 }), capacity: null }))).toBeNull();
  });

  it("needs every sale made here, with none left aboard, on a later lap", () => {
    const plan = loop({ lap: 2 });
    const events = [
      docked(10, "Kremainn", "Wohler Terminal", 7),
      sell(8, "Silver", 720, 4_000, {}, 7),
    ];
    // Sold the silver, not yet bought the gold.
    expect(tradeAdvance(input({ plan, events, cargo: [] }))).toBeNull();
    expect(
      tradeAdvance(input({ plan, events: [...events, buy(5, "Gold", 720, 9_400, 7)] })),
    ).toMatchObject({ index: 0, key: expect.stringMatching(/^trade\|2\|0\|/) });
    // A sale before docking, or at another market, is not this stop's.
    const before = [
      sell(20, "Silver", 720, 4_000, {}, 7),
      docked(10, "Kremainn", "Wohler Terminal", 7),
    ];
    expect(tradeAdvance(input({ plan, events: before }))).toBeNull();
    const elsewhere = [
      docked(10, "Kremainn", "Wohler Terminal", 7),
      sell(8, "Silver", 720, 4_000, {}, 99),
    ];
    expect(tradeAdvance(input({ plan, events: elsewhere }))).toBeNull();
    // Still some silver aboard.
    expect(
      tradeAdvance(input({ plan, events, cargo: hold({ Silver: 20, Gold: 720 }) })),
    ).toBeNull();
  });

  it("marks a stop with nothing to buy or sell done on docking, and copies the next system", () => {
    const plan = route([stop("A", "a", []), stop("B", "b", [])]);
    const step = tradeAdvance({
      plan,
      events: [docked(1, "A", "a", 3)],
      cargo: [],
      capacity: 100,
      location: where("A", "a"),
    });
    expect(step?.index).toBe(0);
    const done = {
      ...plan,
      stops: [{ ...plan.stops[0]!, status: "done" as const }, plan.stops[1]!],
    };
    expect(tradeNextCopy(done, "A")).toBe("B");
    // The next stop in this system, or none left: nothing to copy.
    expect(tradeNextCopy(done, "B")).toBeNull();
    expect(
      tradeNextCopy(
        { ...done, stops: done.stops.map((s) => ({ ...s, status: "done" as const })) },
        "A",
      ),
    ).toBeNull();
  });
});

describe("the trade panel", () => {
  const base = {
    plan: loop() as Plan | null,
    events: [] as JournalEvent[],
    cargo: [] as Cargo,
    capacity: 720,
    location: where("Kremainn", null),
    market: null as ReturnType<typeof parseMarket>,
    missions: [] as Mission[],
    now: NOW,
  };

  it("shows the current stop's buy, the hold, and the next stop", () => {
    const p = tradePanel(base)!;
    expect(p).toMatchObject({
      mode: "trade",
      title: "TRADE",
      subtitle: "Loop: Kremainn ⇄ Wolf 397",
      right: "lap 1",
      footer: [],
    });
    expect(p.rows).toEqual([
      { text: "● Kremainn · Wohler Terminal", right: "BUY 720 t Gold" },
      { text: "  hold 0/720 · plan 9,380", tone: undefined },
      {
        text: "▸ Wolf 397 · Brooks Estate",
        right: "SELL 720 t Gold · BUY 720 t Silver",
        tone: "dim",
      },
    ]);
  });

  it("shows the live price against the plan while docked at the stop", () => {
    const events = [docked(10, "Kremainn", "Wohler Terminal", 7), buy(5, "Gold", 300, 9_410, 7)];
    const input = {
      ...base,
      events,
      cargo: hold({ Gold: 300 }),
      location: where("Kremainn", "Wohler Terminal"),
      market: market(7, { Gold: [9_410, 9_000] }),
    };
    expect(tradePanel(input)!.rows[1]).toEqual({
      text: "  hold 300/720 · price 9,410 (plan 9,380)",
      tone: undefined,
    });
    // A market that moved against the plan shows in amber.
    const dear = tradePanel({ ...input, market: market(7, { Gold: [10_000, 9_000] }) })!;
    expect(dear.rows[1]).toEqual({
      text: "  hold 300/720 · price 10,000 (plan 9,380)",
      tone: "warn",
    });
    // Another station's market file is not this one's.
    expect(tradePanel({ ...input, market: market(8, { Gold: [1, 1] }) })!.rows[1]!.text).toBe(
      "  hold 300/720 · plan 9,380",
    );
    // A commodity this market does not sell.
    expect(tradePanel({ ...input, market: market(7, { Tea: [1, 1] }) })!.rows[1]!.text).toBe(
      "  hold 300/720 · plan 9,380",
    );
    // Bought: green.
    expect(tradePanel({ ...input, cargo: hold({ Gold: 720 }) })!.rows[1]!.tone).toBe("good");
  });

  it("lists a stop's sale and buy on their own lines after the first lap", () => {
    const p = tradePanel({
      ...base,
      plan: loop({ lap: 3 }),
      events: [docked(10, "Kremainn", "Wohler Terminal", 7)],
      cargo: hold({ Silver: 720 }),
      location: where("Kremainn", "Wohler Terminal"),
      market: market(7, { Silver: [0, 3_000], Gold: [9_380, 0] }),
    })!;
    expect(p.right).toBe("lap 3");
    expect(p.rows.slice(0, 3)).toEqual([
      { text: "● Kremainn · Wohler Terminal" },
      {
        text: "  SELL 720 t Silver",
        right: "hold 720/720 · price 3,000 (plan 4,200)",
        tone: "warn",
      },
      { text: "  BUY 720 t Gold", right: "hold 0/720 · price 9,380 (plan 9,380)", tone: undefined },
    ]);
  });

  it("shows a pass-through stop, old prices, and a route with no lap", () => {
    const plan = route(
      [stop("A", "a", []), stop("B", "b", [{ commodity: "Tea", action: "sell", amount: 5 }])],
      {
        prices_at: new Date(NOW - 30 * 3_600_000).toISOString(),
      },
    );
    const p = tradePanel({ ...base, plan })!;
    expect(p.subtitle).toBe("Route: A → C, 3 stops");
    expect(p.right).toBe("prices 30h old");
    expect(p.rows).toEqual([
      { text: "● A · a", right: "pass through" },
      { text: "▸ B · b", right: "SELL 5 t Tea", tone: "dim" },
    ]);
    const older = { ...plan, prices_at: new Date(NOW - 100 * 3_600_000).toISOString() };
    expect(tradePanel({ ...base, plan: older })!.right).toBe("prices 4d old");
    // A day old or less, or unreadable, shows nothing.
    expect(
      tradePanel({ ...base, plan: { ...plan, prices_at: new Date(NOW).toISOString() } })!.right,
    ).toBeUndefined();
    // The last stop: nothing next; a stop with no price shows only the hold.
    const last = {
      ...plan,
      stops: [{ ...plan.stops[0]!, status: "done" as const }, plan.stops[1]!],
    };
    expect(tradePanel({ ...base, plan: last })!.rows).toEqual([
      { text: "● B · b", right: "SELL 5 t Tea" },
      { text: "  hold 0/5", tone: undefined },
    ]);
    // A stop with no station.
    const bare = route([{ system: "Z", purpose: "p", kind: "trade", status: "todo" }]);
    expect(tradePanel({ ...base, plan: bare })!.rows[0]!.text).toBe("● Z");
  });

  it("shows the hold with no plan, and the session's profit an hour", () => {
    const events = [
      at(60, "LoadGame"),
      buy(40, "Gold", 100, 10_000),
      sell(20, "Gold", 100, 20_000),
    ];
    const p = tradePanel({
      ...base,
      plan: null,
      events,
      cargo: [...hold({ Gold: 100, drones: 4 }), ...hold({ Tea: 3 }, 55)],
    })!;
    expect(p.subtitle).toBeUndefined();
    expect(p.rows).toEqual([
      { text: "Gold", right: "100 t" },
      { text: "No trade plan: ask Claude for a trade loop or route", tone: "dim" },
    ]);
    // 1.0M over 20 minutes counted: from the first trade, a gap counts up to 10 minutes.
    expect(p.right).toBe("3.0M/h");
    expect(p.footer).toEqual(["Session: 1.0M profit · 20m · 3.0M/h"]);
    // A new session with no trade yet has no session line.
    expect(
      tradePanel({ ...base, plan: null, cargo: hold({ Gold: 1 }), events: [] })!.footer,
    ).toEqual([]);
    // Under a minute.
    expect(tradePanel({ ...base, events: [buy(0, "Gold", 1, 1)], now: NOW })!.footer[0]).toBe(
      "Session: 0 profit · 0m",
    );
  });

  it("says when the route is done, and shows nothing with no route and an empty hold", () => {
    const plan = route([stop("A", "a", [], "done")]);
    expect(tradePanel({ ...base, plan, cargo: hold({ Gold: 5 }) })!.rows.at(-1)).toEqual({
      text: "Trade route done",
      tone: "dim",
    });
    expect(tradePanel({ ...base, plan })).toBeNull();
    // A plan with no trade stops is not a trade plan.
    const other = route([{ system: "S", purpose: "p", kind: "fuel", status: "todo" }]);
    expect(tradePanel({ ...base, plan: other })).toBeNull();
  });

  it("adds a line for passengers and deliveries taken on the run", () => {
    const m = (id: number, o: Partial<Mission>) =>
      ({
        id,
        destination_system: "X",
        status: "active",
        passengers: null,
        commodity: null,
        count: null,
        kill_count: null,
        ...o,
      }) as Mission;
    expect(
      tradePanel({ ...base, missions: [m(1, { passengers: 6 }), m(2, { passengers: 2 })] })!.footer,
    ).toEqual(["Passengers: 8 aboard · 2 missions"]);
    expect(
      tradePanel({ ...base, missions: [m(3, { commodity: "Gold", count: 5 })] })!.footer,
    ).toEqual(["Deliveries: 1 mission"]);
  });
});

describe("trade mode", () => {
  const ALL = () => true;
  const active: TradeNow = { active: true, missionCargo: false, stops: [] };
  const jump = (m: number) => at(m, "FSDJump", { StarSystem: `S${m}` });

  it("asks the reader to keep the events it reads", () => {
    expect(TRADE_EVENTS.filter((e) => !(HUD_EVENTS as readonly string[]).includes(e))).toEqual([]);
  });

  it("turns on with a market buy, unless the hold has mission cargo", () => {
    const events = [at(10, "FSSDiscoveryScan"), buy(5, "Gold", 1, 1)];
    expect(journalMode(events, false, false, ALL, false, active)).toEqual({
      mode: "trade",
      at: NOW - 5 * MIN,
    });
    expect(
      journalMode(events, false, false, ALL, false, { ...active, missionCargo: true })?.mode,
    ).toBe("exploration");
    // Off, or with nothing to show, a buy changes nothing.
    expect(journalMode(events, false, false, (m) => m !== "trade", false, active)?.mode).toBe(
      "exploration",
    );
    expect(
      journalMode([buy(5, "Gold", 1, 1)], false, false, ALL, false, { ...active, active: false }),
    ).toBeNull();
    expect(journalMode([buy(5, "Gold", 1, 1)], false, false, ALL)).toBeNull();
  });

  it("turns on when docking at a stop of the trade plan", () => {
    const trade = { ...active, stops: [{ system: "Kremainn", station: "Wohler Terminal" }] };
    expect(
      journalMode([docked(5, "Kremainn", "Wohler Terminal", 7)], false, false, ALL, false, trade)
        ?.mode,
    ).toBe("trade");
    expect(
      journalMode([docked(5, "Kremainn", "Other", 8)], false, false, ALL, false, trade),
    ).toBeNull();
  });

  it(`ends after ${LAPSE_JUMPS} jumps with no market trade`, () => {
    const jumps = (n: number) => Array.from({ length: n }, (_, i) => jump(20 - i));
    const bought = [buy(30, "Gold", 1, 1)];
    expect(
      journalMode([...bought, ...jumps(LAPSE_JUMPS - 1)], false, false, ALL, false, active)?.mode,
    ).toBe("trade");
    expect(
      journalMode([...bought, ...jumps(LAPSE_JUMPS)], false, false, ALL, false, active),
    ).toBeNull();
    // A sale, or a buy with mission cargo aboard, counts as a trade.
    const sold = [...bought, ...jumps(3), sell(10, "Gold", 1, 2), ...jumps(3)];
    expect(journalMode(sold, false, false, ALL, false, active)?.mode).toBe("trade");
    const mission = { ...active, missionCargo: true };
    const rebought = [...bought, ...jumps(3), buy(10, "Tea", 1, 1), ...jumps(3)];
    // With mission cargo the first buy did not start trade either.
    expect(journalMode(rebought, false, false, ALL, false, mission)).toBeNull();
    const started = [...bought, ...jumps(3)];
    expect(journalMode(started, false, false, ALL, false, active)?.mode).toBe("trade");
  });

  it("keeps a run's passengers on the trade panel, and yields to a newer activity", () => {
    const events = [buy(10, "Gold", 1, 1), at(5, "MissionAccepted", { PassengerCount: 2 })];
    expect(journalMode(events, false, false, ALL, true, active)?.mode).toBe("trade");
    // Passengers taken before trading show once trade ends.
    expect(journalMode(events, false, false, ALL, true, { ...active, active: false })?.mode).toBe(
      "passenger",
    );
    expect(
      journalMode([...events, at(1, "ProspectedAsteroid")], false, false, ALL, true, active)?.mode,
    ).toBe("mining");
  });

  it("follows a trading note only with a trade plan", () => {
    expect(noteMode("trading")).toBe("trade");
  });
});

describe("trade in the panel", () => {
  const journal = (o: Partial<JournalState> = {}, events: JournalEvent[] = []) => ({
    commander: null,
    credits: null,
    location: where("Kremainn", null),
    ship: {
      type: "type9",
      name: null,
      ident: null,
      max_jump_range: null,
      cargo_capacity: 720,
      fuel_capacity: null,
    },
    cargo: [],
    materials: { raw: [], manufactured: [], encoded: [] },
    missions: [],
    engineers: [],
    as_of: null,
    ...o,
    events,
  });
  const input = (o: Partial<HudInput> = {}): HudInput => ({
    journal: journal(),
    status: null,
    nav: null,
    activity: null,
    plan: null,
    hotkey: null,
    samples: new Map(),
    known: null,
    settings: DEFAULT_SETTINGS.hud,
    now: NOW,
    ...o,
  });
  const note = {
    kind: "trading",
    updated_at: new Date(NOW - MIN).toISOString(),
    plan_id: "trade",
  } as never;

  it("follows a trading note with a trade plan to the trade panel", () => {
    const i = input({ activity: note, plan: loop() });
    expect(currentMode(i)).toBe("trade");
    const v = buildHud(i, null);
    expect(v.panel?.title).toBe("TRADE");
    // The route rows show below, as for any plan.
    expect(v.route?.[0]).toMatchObject({ kind: "current", text: "Wohler Terminal, Kremainn" });
  });

  it("does not follow a trading note with no trade stop to do, or with the mode off", () => {
    expect(currentMode(input({ activity: note }))).toBeNull();
    const off = { ...DEFAULT_SETTINGS.hud, modes: { ...DEFAULT_SETTINGS.hud.modes, trade: false } };
    expect(currentMode(input({ activity: note, plan: loop(), settings: off }))).toBeNull();
  });

  it("shows trade from a market buy while the hold has the goods, and ends once it is empty", () => {
    const events = [buy(5, "Gold", 10, 1_000)];
    const i = input({ journal: journal({ cargo: hold({ Gold: 10 }) }, events) });
    expect(currentMode(i)).toBe("trade");
    expect(buildHud(i, null).panel?.rows[0]).toEqual({ text: "Gold", right: "10 t" });
    expect(currentMode(input({ journal: journal({}, events) }))).toBeNull();
    // Mission cargo aboard: the buy is for the mission.
    const mission = input({ journal: journal({ cargo: hold({ Gold: 10 }, 9) }, events) });
    expect(currentMode(mission)).toBeNull();
  });
});
