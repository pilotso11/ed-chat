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
  tradeBuys,
  type MissionsNow,
  TRADE_EVENTS,
  tradeNextCopy,
  tradePanel,
  tradeTodo,
  tradeTotals,
  tradeJournal,
  missionsNow,
  NO_MISSIONS,
} from "../src/core/hud/trade.js";
import { commodityKey } from "../src/core/hud/mining.js";
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
    expect(m.at).toBe(NOW);
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

  it("replays the journal again once it grows", () => {
    const events = [buy(3, "Gold", 1, 1)];
    expect(tradeTotals(events, NOW).profit).toBe(0);
    events.push(sell(2, "Gold", 1, 3));
    expect(tradeTotals(events, NOW).profit).toBe(2);
  });

  it("leaves buys for a mission or a depot out of the cost, and cargo that leaves without a sale", () => {
    const source = at(50, "MissionAccepted", { MissionID: 1, Commodity: "$Gold_Name;", Count: 5 });
    // Bought for the mission: no trade, no cost, no clock.
    const forMission = tradeTotals([source, buy(40, "Gold", 5, 100)], NOW, NO_MISSIONS);
    expect(forMission).toMatchObject({ trades: 0, active: 0 });
    const tons = (events: JournalEvent[]) => tradeJournal(events).tons.get("gold") ?? 0;
    const bought = [buy(40, "Gold", 10, 100)];
    expect(tons(bought)).toBe(10);
    expect(
      tons([
        ...bought,
        at(35, "ColonisationContribution", {
          Contributions: [{ Name: "$gold_name;", Name_Localised: "Gold", Amount: 2 }],
        }),
        at(34, "CargoTransfer", {
          Transfers: [
            { Type: "gold", Count: 3, Direction: "tocarrier" },
            { Type: "gold", Count: 1, Direction: "toship" },
          ],
        }),
        at(33, "EjectCargo", { Type: "gold", Count: 1 }),
        at(32, "EjectCargo", { Type: "gold", Count: 1, MissionID: 4 }),
        // A source mission handed in takes its goods; a delivery's goods were its own.
        at(31, "MissionCompleted", { MissionID: 2, Commodity: "$Gold_Name;", Count: 1 }),
        at(30, "MissionCompleted", {
          MissionID: 3,
          Commodity: "$Gold_Name;",
          Count: 1,
          DestinationSystem: "X",
        }),
      ]),
    ).toBe(3);
    // Sold after some left: only the tons left carry a cost.
    const left = [
      ...bought,
      at(35, "EjectCargo", { Type: "gold", Count: 5 }),
      sell(30, "Gold", 10, 200),
    ];
    expect(tradeTotals(left, NOW).profit).toBe(500);
  });

  it("replays once for the mode and the panel, whatever else they pass with the missions", () => {
    const events = [buy(3, "Gold", 1, 1)];
    const missions = { missionCargo: [{ id: 1, commodity: "Tea" }], wanted: [] };
    const first = tradeJournal(events, missions);
    // journalMode passes its whole TradeNow, which holds the same missions.
    const mode = { ...missions, active: true, aboard: true, stops: [] };
    expect(tradeJournal(events, mode as MissionsNow)).toBe(first);
    expect(tradeJournal(events, { ...missions, wanted: [{ id: 2, commodity: "Tea" }] })).not.toBe(
      first,
    );
  });

  it("counts a sale the trade plan makes though its buy is not in the journal", () => {
    const gold = sell(30, "Gold", 10, 30_000, { AvgPricePaid: 10_000 });
    const plan = { planSells: ["gold"], missionCargo: [], wanted: [] };
    expect(tradeTotals([gold], NOW, plan)).toMatchObject({ profit: 200_000, trades: 1 });
    expect(tradeJournal([gold], plan).sales.size).toBe(1);
    // Goods the plan does not sell, never bought: a reward, stolen or mined.
    const tea = sell(29, "Tea", 10, 3_000, { AvgPricePaid: 1_000 });
    expect(tradeTotals([tea], NOW, plan).trades).toBe(0);
    // With no price paid, nothing to cost it at.
    const free = sell(28, "Gold", 10, 30_000, { AvgPricePaid: 0 });
    expect(tradeTotals([free], NOW, plan).trades).toBe(0);
    // The plan's sells, from its trade stops.
    expect(missionsNow({ cargo: [], missions: [] }, loop()).planSells?.sort()).toEqual([
      "gold",
      "silver",
    ]);
    expect(missionsNow({ cargo: [], missions: [] }).planSells).toEqual([]);
  });

  it("replays again when the same array's tail changes at the same length", () => {
    const events = [buy(5, "Gold", 1, 1), buy(4, "Gold", 1, 1)];
    expect(tradeJournal(events).trades).toBe(2);
    events.shift();
    events.push(sell(3, "Gold", 1, 3));
    const j = tradeJournal(events);
    expect(j.sales.size).toBe(1);
    expect(tradeTotals(events, NOW).profit).toBe(2);
    // The same kind of event in the same second, but another one.
    events[events.length - 1] = sell(3, "Gold", 1, 5);
    expect(tradeTotals(events, NOW).profit).toBe(4);
  });

  it("takes cargo moved by its internal name out of the cost", () => {
    const bought = at(40, "MarketBuy", {
      Type: "agritreatment",
      Type_Localised: "Agronomic Treatment",
      Count: 10,
      BuyPrice: 100,
      TotalCost: 1_000,
    });
    const moved = at(30, "CargoTransfer", {
      Transfers: [{ Type: "agritreatment", Count: 4, Direction: "tocarrier" }],
    });
    const j = tradeJournal([bought, moved]);
    expect(j.tons.get(commodityKey("Agronomic Treatment"))).toBe(6);
    expect(j.tons.get("agritreatment")).toBe(6);
  });

  it("has no rate before five minutes", () => {
    const t = tradeTotals([buy(3, "Gold", 1, 1), sell(2, "Gold", 1, 3)], NOW);
    expect(t.profit).toBe(2);
    expect(t.rate.session).toBeNull();
  });

  it("uses the sale's average price paid only for more of a traded commodity, and skips the rest", () => {
    const events = [
      // Never bought as trade: a mission's reward, stolen or mined, whatever the game says was paid.
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
    expect(t.profit).toBe(10_000 + 5_000);
    // The silver buy and its sale.
    expect(t.trades).toBe(2);
    expect(tradeJournal(events).sales.size).toBe(1);
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

  it("keeps the visit over a relog while docked, so trades before it count", () => {
    const station = { StarSystem: "Kremainn", StationName: "Wohler Terminal", MarketID: 7 };
    const events = [
      docked(30, "Kremainn", "Wohler Terminal", 7),
      sell(25, "Gold", 720, 30_000, {}, 7),
      at(20, "Shutdown"),
      at(10, "Location", { ...station, Docked: true }),
    ];
    expect(dockedAt(events, where("Kremainn", "Wohler Terminal"))?.index).toBe(0);
    const plan = route([
      stop("Kremainn", "Wohler Terminal", [{ commodity: "Gold", action: "sell", amount: 720 }]),
    ]);
    const input = {
      plan,
      events,
      cargo: [],
      capacity: 720,
      location: where("Kremainn", "Wohler Terminal"),
    };
    expect(tradeAdvance(input)?.index).toBe(0);
    // Undocked between: a new visit.
    const again = [
      ...events.slice(0, 2),
      at(22, "Undocked"),
      at(10, "Location", { ...station, Docked: true }),
    ];
    expect(dockedAt(again, where("Kremainn", "Wohler Terminal"))?.index).toBe(3);
    // Another station before it: a new visit.
    const moved = [
      docked(30, "Kremainn", "Other", 8),
      at(10, "Location", { ...station, Docked: true }),
    ];
    expect(dockedAt(moved, where("Kremainn", "Wohler Terminal"))?.index).toBe(1);
  });

  it("knows the ship is docked after the game restarts there", () => {
    const restart = at(5, "Location", {
      StarSystem: "Kremainn",
      StationName: "Wohler Terminal",
      Docked: true,
      MarketID: 7,
    });
    expect(dockedAt([restart], where("Kremainn", "Wohler Terminal"))).toMatchObject({
      marketId: 7,
      index: 0,
    });
    const flying = at(5, "Location", { StarSystem: "Kremainn", StationName: "Wohler Terminal" });
    expect(dockedAt([flying], where("Kremainn", "Wohler Terminal"))).toBeNull();
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

describe("buys that are trade", () => {
  const none: MissionsNow = { missionCargo: [], wanted: [] };
  const accepted = (m: number, id: number, o: Record<string, unknown>) =>
    at(m, "MissionAccepted", {
      MissionID: id,
      Name: "Mission_Delivery",
      Commodity: "$AgriculturalMedicines_Name;",
      Commodity_Localised: "Agri-Medicines",
      Count: 5,
      Expiry: new Date(NOW + 3_600_000).toISOString(),
      ...o,
    });
  const tea = (m: number) => buy(m, "Tea", 5, 1);
  const agriBuy = (m: number) =>
    at(m, "MarketBuy", {
      Type: "agriculturalmedicines",
      Type_Localised: "Agri-Medicines",
      Count: 5,
    });
  const trade = (events: JournalEvent[], now = none) => [...tradeBuys(events, now)];

  it("counts a buy made with no mission cargo aboard, and not limpets", () => {
    const limpets = at(5, "MarketBuy", { Type: "drones", Type_Localised: "Limpet", Count: 4 });
    const bought = tea(5);
    expect(trade([bought, limpets])).toEqual([bought]);
  });

  it("leaves out a buy of a delivery's goods while aboard, until it ends or expires", () => {
    const d = accepted(30, 1, { DestinationSystem: "X" });
    // Other goods bought meanwhile are trade.
    expect(trade([d, tea(20)])).toHaveLength(1);
    expect(trade([d, agriBuy(20)])).toEqual([]);
    const done = at(25, "MissionCompleted", { MissionID: 1 });
    expect(trade([d, done, agriBuy(20)])).toHaveLength(1);
    // Expired with the game off: no event ends it.
    const expired = accepted(120, 2, {
      DestinationSystem: "X",
      Expiry: new Date(NOW - 60 * MIN).toISOString(),
    });
    expect(trade([expired, agriBuy(20)])).toHaveLength(1);
    // Cargo aboard now of a mission taken before the journal's window was aboard all along.
    expect(
      trade([agriBuy(20)], { ...none, missionCargo: [{ id: 9, commodity: "Agri-Medicines" }] }),
    ).toEqual([]);
  });

  it("counts a depot or wing delivery's cargo aboard only once collected, until delivered", () => {
    const wing = accepted(30, 3, { Name: "Mission_Delivery_Wing", DestinationSystem: "X" });
    expect(trade([wing, agriBuy(25)])).toHaveLength(1);
    const collect = at(24, "CargoDepot", { MissionID: 3, UpdateType: "Collect", Count: 5 });
    expect(trade([wing, collect, agriBuy(20)])).toEqual([]);
    const delivered = at(22, "CargoDepot", {
      MissionID: 3,
      UpdateType: "Deliver",
      ItemsDelivered: 5,
      TotalItemsToDeliver: 5,
    });
    expect(trade([wing, collect, delivered, agriBuy(20)])).toHaveLength(1);
    // A depot mission not named wing is known by its CargoDepot events.
    const depot = accepted(30, 4, { DestinationSystem: "X" });
    const collected = at(10, "CargoDepot", { MissionID: 4, UpdateType: "Collect", Count: 5 });
    expect(trade([depot, agriBuy(20), collected])).toHaveLength(1);
    // A collect for a mission taken before the window.
    expect(
      trade([
        at(24, "CargoDepot", {
          MissionID: 77,
          UpdateType: "Collect",
          CargoType: "AgriculturalMedicines",
          CargoType_Localised: "Agri-Medicines",
        }),
        agriBuy(20),
      ]),
    ).toEqual([]);
  });

  it("leaves out a buy of goods an open mission asks for", () => {
    const source = accepted(30, 5, {});
    const agri = at(20, "MarketBuy", {
      Type: "agriculturalmedicines",
      Type_Localised: "Agri-Medicines",
      Count: 5,
    });
    expect(trade([source, agri])).toEqual([]);
    // Other goods are trade.
    expect(trade([source, tea(20)])).toHaveLength(1);
    // Abandoned, the buy is trade again.
    expect(trade([source, at(25, "MissionAbandoned", { MissionID: 5 }), agri])).toHaveLength(1);
    // A mission open now, taken before the journal's window.
    expect(trade([agri], { ...none, wanted: [{ id: 8, commodity: "Agri-Medicines" }] })).toEqual(
      [],
    );
    // Passengers and massacres ask for no goods.
    expect(trade([accepted(30, 6, { PassengerCount: 2 }), agri])).toHaveLength(1);
    expect(trade([accepted(30, 7, { KillCount: 20 }), agri])).toHaveLength(1);
  });

  it("leaves out buys while supplying a colonisation depot", () => {
    const gave = at(60, "ColonisationContribution", {});
    expect(trade([gave, tea(20)])).toEqual([]);
    // Opening the depot screen is not supplying it.
    const looked = at(60, "ColonisationConstructionDepot", { ConstructionComplete: false });
    expect(trade([looked, tea(20)])).toHaveLength(1);
    // Long ago, or finished.
    expect(trade([at(200, "ColonisationContribution", {}), tea(20)])).toHaveLength(1);
    const built = at(30, "ColonisationConstructionDepot", { ConstructionComplete: true });
    expect(trade([gave, built, tea(20)])).toHaveLength(1);
    const failed = at(30, "ColonisationConstructionDepot", { ConstructionFailed: true });
    expect(trade([gave, failed, tea(20)])).toHaveLength(1);
  });

  it("leaves out buys of the goods a viewed colonisation depot still needs", () => {
    // As the game writes it.
    const depot = (m: number, o: Record<string, unknown> = {}) =>
      at(m, "ColonisationConstructionDepot", {
        MarketID: 3958194946,
        ConstructionProgress: 0.48,
        ConstructionComplete: false,
        ConstructionFailed: false,
        ResourcesRequired: [
          {
            Name: "$aluminium_name;",
            Name_Localised: "Aluminium",
            RequiredAmount: 10055,
            ProvidedAmount: 5702,
            Payment: 3239,
          },
          {
            Name: "$copper_name;",
            Name_Localised: "Copper",
            RequiredAmount: 644,
            ProvidedAmount: 644,
            Payment: 1050,
          },
        ],
        ...o,
      });
    const aluminium = (m: number) => buy(m, "Aluminium", 100, 300);
    expect(trade([depot(60), aluminium(20)])).toEqual([]);
    // Goods it no longer needs, and other goods, are trades.
    expect(trade([depot(60), buy(20, "Copper", 100, 300)])).toHaveLength(1);
    expect(trade([depot(60), tea(20)])).toHaveLength(1);
    // Long ago, or since built.
    expect(trade([depot(200), aluminium(20)])).toHaveLength(1);
    expect(
      trade([depot(60), depot(40, { ConstructionComplete: true }), aluminium(20)]),
    ).toHaveLength(1);
  });
});

describe("commodity names", () => {
  // The journal's internal names are not always the English ones the plan has.
  const agri = (m: number, event: string, o: Record<string, unknown>) =>
    at(m, event, { Type: "agriculturalmedicines", Type_Localised: "Agri-Medicines", ...o });
  const plan = route([
    stop("Kremainn", "Wohler Terminal", [
      { commodity: "Agri-Medicines", action: "buy", amount: 10, price: 1_000 },
    ]),
  ]);

  it("matches the market, the hold and the journal by the game's names", () => {
    const market = parseMarket(
      JSON.stringify({
        timestamp: new Date(NOW).toISOString(),
        MarketID: 7,
        StationName: "Wohler Terminal",
        Items: [
          {
            Name: "$agriculturalmedicines_name;",
            Name_Localised: "Agri-Medicines",
            BuyPrice: 1_100,
            SellPrice: 900,
          },
        ],
      }),
    );
    // ed-mcp names cargo by its Name_Localised.
    const cargo = hold({ "Agri-Medicines": 10 });
    const events = [
      docked(10, "Kremainn", "Wohler Terminal", 7),
      agri(5, "MarketBuy", { MarketID: 7, Count: 10, BuyPrice: 1_100, TotalCost: 11_000 }),
    ];
    const location = where("Kremainn", "Wohler Terminal");
    expect(tradeAdvance({ plan, events, cargo, capacity: 100, location })?.index).toBe(0);
    const p = tradePanel({
      plan,
      events,
      cargo,
      capacity: 100,
      location,
      market,
      missions: [],
      now: NOW,
    });
    expect(p!.rows[1]!.text).toBe("  hold 10/10 · price 1,100 (plan 1,000)");
    // The cost of the tons bought carries to their sale.
    const sold = agri(1, "MarketSell", { Count: 10, SellPrice: 2_000, TotalSale: 20_000 });
    expect(tradeTotals([...events, sold], NOW).profit).toBe(9_000);
  });

  it("falls back to the internal name when the journal gives no other", () => {
    const m = parseMarket(
      JSON.stringify({ MarketID: 1, StationName: "X", Items: [{ Name: "gold" }] }),
    );
    expect([...m!.items.keys()]).toEqual(["gold"]);
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

  it("does not count cargo brought from an earlier stop as bought here", () => {
    expect(
      tradeAdvance(input({ events: [docked(10, "Kremainn", "Wohler Terminal", 7)] })),
    ).toBeNull();
    // Bought at another market before.
    const earlier = [buy(20, "Gold", 720, 1, 3), docked(10, "Kremainn", "Wohler Terminal", 7)];
    expect(tradeAdvance(input({ events: earlier }))).toBeNull();
  });

  it("marks a stop with no station done at any station in its system", () => {
    const plan = route([
      {
        system: "Kremainn",
        purpose: "p",
        kind: "trade",
        status: "todo",
        cargo: [{ commodity: "Gold", action: "buy", amount: 720 }],
      },
    ]);
    expect(tradeAdvance(input({ plan }))?.index).toBe(0);
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

  it("judges only when the plan's current stop is a trade stop", () => {
    const fuel = {
      system: "Kremainn",
      station: "Wohler Terminal",
      purpose: "fuel",
      kind: "fuel" as const,
      status: "todo" as const,
    };
    const gold = stop("Kremainn", "Wohler Terminal", [
      { commodity: "Gold", action: "buy", amount: 720 },
    ]);
    const plan = route([fuel, gold]);
    expect(tradeAdvance(input({ plan }))).toBeNull();
    // Once the fuel stop is done, the trade stop is current.
    const fueled = route([{ ...fuel, status: "done" }, gold]);
    expect(tradeAdvance(input({ plan: fueled }))?.index).toBe(1);
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

  it("counts the stop among all the plan's stops in visit order", () => {
    const fuel = {
      system: "F",
      station: "f",
      purpose: "fuel",
      kind: "fuel" as const,
      status: "done" as const,
    };
    const a = stop("A", "a", []);
    const b = stop("B", "b", []);
    // Trade, fuel, trade: at the second trade stop, after the fuel stop.
    const mixed = route([{ ...a, status: "done" }, fuel, b]);
    expect(tradePanel({ ...base, plan: mixed })!.right).toBe("stop 3/3");
    // A saved route visits B first: A, done last in the stops, is the second stop.
    const reordered = route([a, b], {
      route: {
        computed_at: new Date(NOW).toISOString(),
        from: "X",
        stops: ["B", "A"],
        total_min: 1,
        plotted: false,
        stop_indexes: [[1], [0]],
      },
    });
    const done = { ...reordered, stops: [a, { ...b, status: "done" as const }] };
    expect(tradePanel({ ...base, plan: done })!.right).toBe("stop 2/2");
    expect(tradePanel({ ...base, plan: reordered })!.right).toBe("stop 1/2");
  });

  it("shows the jumps left on the row of the stop the plotted route leads to", () => {
    const nav = { systems: ["Here", "Mid", "Wolf 397"] };
    const location = where("Here", null);
    const p = tradePanel({ ...base, plan: loop({ lap: 2 }), nav, location })!;
    expect(p.rows.find((r) => r.text.startsWith("▸"))!.right).toBe(
      "SELL 720 t Gold · BUY 720 t Silver · 2 jumps",
    );
    expect(p.rows[0]!.right).toBeUndefined();
    // A route to the current stop: on its row.
    const toCur = { systems: ["Here", "Kremainn"] };
    const q = tradePanel({ ...base, nav: toCur, location })!;
    expect(q.rows[0]!.right).toBe("BUY 720 t Gold · 1 jump");
    const many = tradePanel({ ...base, plan: loop({ lap: 2 }), nav: toCur, location })!;
    expect(many.rows[0]!.right).toBe("1 jump");
    const pass = route([stop("A", "a", []), stop("B", "b", [])]);
    expect(
      tradePanel({ ...base, plan: pass, nav: { systems: ["Here", "A"] }, location })!.rows[0]!
        .right,
    ).toBe("pass through · 1 jump");
  });

  it("shows the current stop's buy, the hold, and the next stop", () => {
    const p = tradePanel(base)!;
    expect(p).toMatchObject({
      mode: "trade",
      title: "TRADE",
      subtitle: "Loop: Kremainn ⇄ Wolf 397",
      right: "stop 1/2 · lap 1",
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
    // A file from an earlier visit to this station has old prices.
    const old = market(7, { Gold: [1, 1] })!;
    expect(tradePanel({ ...input, market: { ...old, at: NOW - 20 * MIN } })!.rows[1]!.text).toBe(
      "  hold 300/720 · plan 9,380",
    );
    expect(tradePanel({ ...input, market: { ...old, at: null } })!.rows[1]!.text).toBe(
      "  hold 300/720 · plan 9,380",
    );
    // A game restarted while docked: the visit began before the events, so the file counts.
    const restarted = {
      ...input,
      events: [
        at(10, "Location", {
          StarSystem: "Kremainn",
          StationName: "Wohler Terminal",
          Docked: true,
          MarketID: 7,
        }),
      ],
    };
    expect(
      tradePanel({ ...restarted, market: { ...old, at: NOW - 20 * MIN } })!.rows[1]!.text,
    ).toBe("  hold 300/720 · price 1 (plan 9,380)");
    // Left before the restart (undocked, died, respawned docked here): only a file since then.
    const left = {
      ...restarted,
      events: [at(30, "Undocked", { StationName: "Wohler Terminal" }), ...restarted.events],
    };
    expect(tradePanel({ ...left, market: { ...old, at: NOW - 40 * MIN } })!.rows[1]!.text).toBe(
      "  hold 300/720 · plan 9,380",
    );
    expect(tradePanel({ ...left, market: { ...old, at: NOW - 20 * MIN } })!.rows[1]!.text).toBe(
      "  hold 300/720 · price 1 (plan 9,380)",
    );
    // A jump, or a docking elsewhere, before it bounds it too.
    for (const before of [
      at(30, "FSDJump", { StarSystem: "Kremainn" }),
      docked(30, "Kremainn", "Other", 8),
    ]) {
      const moved = { ...restarted, events: [before, ...restarted.events] };
      expect(tradePanel({ ...moved, market: { ...old, at: NOW - 40 * MIN } })!.rows[1]!.text).toBe(
        "  hold 300/720 · plan 9,380",
      );
    }
    // Still only this station's.
    expect(tradePanel({ ...restarted, market: { ...old, marketId: 8 } })!.rows[1]!.text).toBe(
      "  hold 300/720 · plan 9,380",
    );
    // An unreadable docking time.
    const noTime = {
      ...input,
      events: [{ ...docked(10, "Kremainn", "Wohler Terminal", 7), timestamp: "" }],
    };
    expect(tradePanel({ ...noTime, market: { ...old, at: null } })!.rows[1]!.text).toBe(
      "  hold 300/720 · price 1 (plan 9,380)",
    );
    // Written at the docking time is this visit's.
    expect(tradePanel({ ...input, market: { ...old, at: NOW - 10 * MIN } })!.rows[1]!.text).toBe(
      "  hold 300/720 · price 1 (plan 9,380)",
    );
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
    expect(p.right).toBe("stop 1/2 · lap 3");
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
    expect(p.right).toBe("stop 1/2 · prices 30h old");
    expect(p.rows).toEqual([
      { text: "● A · a", right: "pass through" },
      { text: "▸ B · b", right: "SELL 5 t Tea", tone: "dim" },
    ]);
    const older = { ...plan, prices_at: new Date(NOW - 100 * 3_600_000).toISOString() };
    expect(tradePanel({ ...base, plan: older })!.right).toBe("stop 1/2 · prices 4d old");
    // A day old or less shows no age.
    expect(
      tradePanel({ ...base, plan: { ...plan, prices_at: new Date(NOW).toISOString() } })!.right,
    ).toBe("stop 1/2");
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
      buy(40, "Gold", 200, 10_000),
      sell(20, "Gold", 100, 20_000),
    ];
    const p = tradePanel({
      ...base,
      plan: null,
      events,
      // Platinum aboard was mined, not bought: it is not trade cargo.
      cargo: [...hold({ Gold: 100, drones: 4, Platinum: 9 }), ...hold({ Tea: 3 }, 55)],
    })!;
    expect(p.subtitle).toBeUndefined();
    expect(p.rows).toEqual([
      { text: "Gold", right: "100 t" },
      { text: "No trade plan: ask Claude for a trade loop or route", tone: "dim" },
    ]);
    // 1.0M over 20 minutes counted: from the first trade, a gap counts up to 10 minutes.
    // No plan, so no stop or lap; the rate is on the Session line.
    expect(p.right).toBeUndefined();
    expect(p.footer[0]).toMatch(/· 3\.0M\/h$/);
    expect(p.footer).toEqual(["Session: 1.0M profit · 20m · 3.0M/h"]);
    // A new session with no trade yet has no session line.
    expect(
      tradePanel({
        ...base,
        plan: null,
        cargo: hold({ Gold: 1 }),
        events: [buy(90, "Gold", 1, 1), at(60, "LoadGame")],
      })!.footer,
    ).toEqual([]);
    // Under a minute.
    expect(tradePanel({ ...base, events: [buy(0, "Gold", 1, 1)], now: NOW })!.footer[0]).toBe(
      "Session: 0 profit · 0m",
    );
  });

  it("leaves stolen cargo out of the hold, the rows and the mode", () => {
    const stolen = [{ name: "Gold", count: 5, stolen: true, mission_id: null }];
    expect(tradePanel({ ...base, plan: null, cargo: stolen })).toBeNull();
    expect(tradePanel({ ...base, cargo: stolen })!.rows[1]!.text).toBe("  hold 0/720 · plan 9,380");
  });

  it("says when the route is done, and shows nothing with no route and an empty hold", () => {
    const plan = route([stop("A", "a", [], "done")]);
    const events = [buy(5, "Gold", 5, 1)];
    expect(tradePanel({ ...base, plan, events, cargo: hold({ Gold: 5 }) })!.rows.at(-1)).toEqual({
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
  const active: TradeNow = { active: true, aboard: true, missionCargo: [], wanted: [], stops: [] };
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
      journalMode(events, false, false, ALL, false, {
        ...active,
        missionCargo: [{ id: 9, commodity: "Gold" }],
      })?.mode,
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
    const mission = { ...active, missionCargo: [{ id: 9, commodity: "Gold" }] };
    const rebought = [...bought, ...jumps(3), buy(10, "Gold", 1, 1), ...jumps(3)];
    // With mission cargo the first buy did not start trade either.
    expect(journalMode(rebought, false, false, ALL, false, mission)).toBeNull();
    const started = [...bought, ...jumps(3)];
    expect(journalMode(started, false, false, ALL, false, active)?.mode).toBe("trade");
  });

  it("keeps a run's passengers on the trade panel, and yields to a newer activity", () => {
    const pax = (m: number) =>
      at(m, "MissionAccepted", { MissionID: 50, PassengerCount: 2, DestinationSystem: "X" });
    const events = [pax(10), buy(5, "Gold", 1, 1)];
    expect(journalMode(events, false, false, ALL, true, active)?.mode).toBe("trade");
    // Passengers taken before trading show once trade ends.
    expect(journalMode(events, false, false, ALL, true, { ...active, active: false })?.mode).toBe(
      "passenger",
    );
    // Taken after the last trade, as when leaving a half-done loop for a passenger run, they win.
    const left = [buy(10, "Gold", 1, 1), pax(5)];
    expect(journalMode(left, false, false, ALL, true, active)?.mode).toBe("passenger");
    expect(
      journalMode([...events, at(1, "ProspectedAsteroid")], false, false, ALL, true, active)?.mode,
    ).toBe("mining");
  });

  it("is not started by buying limpets, so mining or exploration stays", () => {
    const limpets = at(1, "MarketBuy", { Type: "drones", Type_Localised: "Limpet", Count: 4 });
    expect(
      journalMode([at(10, "ProspectedAsteroid"), limpets], false, false, ALL, false, active)?.mode,
    ).toBe("mining");
    // With an empty hold trade would show nothing, and must not end exploration either.
    const empty = { ...active, active: false };
    expect(
      journalMode([at(10, "FSSDiscoveryScan"), limpets], false, false, ALL, false, empty)?.mode,
    ).toBe("exploration");
    // Limpets bought are not a trade in the session's profit either.
    expect(tradeTotals([limpets], NOW).trades).toBe(0);
  });

  it("judges each buy by the mission cargo aboard when it was made", () => {
    const delivery = (m: number, id: number) =>
      at(m, "MissionAccepted", {
        MissionID: id,
        Commodity: "$Gold_Name;",
        Count: 5,
        DestinationSystem: "X",
      });
    // A delivery taken, a buy while its cargo was aboard, then handed in: the old buy is still not
    // a trade, though the hold has no mission cargo now.
    const handedIn = [
      delivery(30, 1),
      buy(20, "Gold", 5, 1),
      at(10, "MissionCompleted", { MissionID: 1 }),
    ];
    expect(journalMode(handedIn, false, false, ALL, false, active)).toBeNull();
    // A buy before taking the delivery now aboard was a trade.
    const before = [buy(20, "Gold", 5, 1), delivery(10, 2)];
    expect(
      journalMode(before, false, false, ALL, false, {
        ...active,
        missionCargo: [{ id: 2, commodity: "Gold" }],
      })?.mode,
    ).toBe("trade");
    // Abandoned or failed, the cargo is gone, and a buy after is a trade.
    for (const end of ["MissionAbandoned", "MissionFailed"]) {
      const ended = [delivery(30, 3), at(25, end, { MissionID: 3 }), buy(20, "Gold", 5, 1)];
      expect(journalMode(ended, false, false, ALL, false, active)?.mode).toBe("trade");
    }
    // Passengers put no cargo in the hold.
    const pax = [
      at(30, "MissionAccepted", { MissionID: 4, PassengerCount: 2, DestinationSystem: "X" }),
      buy(20, "Tea", 5, 1),
    ];
    expect(journalMode(pax, false, false, ALL, false, active)?.mode).toBe("trade");
  });

  it("counts only trade buys and sales of traded cargo as trades for the jump count", () => {
    const jumps = (n: number) => Array.from({ length: n }, (_, i) => jump(20 - i));
    const bought = [buy(30, "Gold", 1, 1)];
    // Selling mined ore, or buying limpets, does not keep trade on.
    const mined = sell(15, "Platinum", 5, 1);
    const limpets = at(14, "MarketBuy", { Type: "drones", Count: 4 });
    expect(
      journalMode(
        [...bought, ...jumps(3), mined, limpets, ...jumps(2)],
        false,
        false,
        ALL,
        false,
        active,
      ),
    ).toBeNull();
    // Selling the traded gold does.
    const sold = sell(15, "Gold", 1, 2);
    expect(
      journalMode([...bought, ...jumps(3), sold, ...jumps(2)], false, false, ALL, false, active)
        ?.mode,
    ).toBe("trade");
  });

  it("does not lapse on a long haul with cargo while a trade stop is still to do", () => {
    const jumps = Array.from({ length: LAPSE_JUMPS + 2 }, (_, i) => jump(20 - i));
    const trade = { ...active, stops: [{ system: "Far", station: "Away" }] };
    const run = [buy(30, "Gold", 1, 1), ...jumps];
    expect(journalMode(run, false, false, ALL, false, trade)?.mode).toBe("trade");
    // A half-done loop left with an empty hold lapses.
    expect(journalMode(run, false, false, ALL, false, { ...trade, aboard: false })).toBeNull();
  });

  it("turns on when the game restarts docked at a stop of the trade plan", () => {
    const trade = { ...active, stops: [{ system: "Kremainn", station: "Wohler Terminal" }] };
    const restart = at(5, "Location", {
      StarSystem: "Kremainn",
      StationName: "Wohler Terminal",
      Docked: true,
    });
    expect(journalMode([restart], false, false, ALL, false, trade)?.mode).toBe("trade");
    const flying = at(5, "Location", { StarSystem: "Kremainn", StationName: "Wohler Terminal" });
    expect(journalMode([flying], false, false, ALL, false, trade)).toBeNull();
  });

  it("matches a trade stop with no station to any station in its system", () => {
    const trade = { ...active, stops: [{ system: "Kremainn" }] };
    expect(
      journalMode([docked(5, "Kremainn", "Any Port", 7)], false, false, ALL, false, trade)?.mode,
    ).toBe("trade");
    expect(
      journalMode([docked(5, "Elsewhere", "Any Port", 7)], false, false, ALL, false, trade),
    ).toBeNull();
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
    // No route rows: the trade panel already shows the stops and how far through the plan.
    expect(v.route).toBeNull();
    expect(v.panel?.right).toBe("stop 1/2 · lap 1");
    // A plan with a fuel stop keeps the route rows, which show it.
    const fuel = { system: "Sol", purpose: "fuel", kind: "fuel" as const, status: "todo" as const };
    const mixed = loop({ stops: [...loop().stops, fuel] });
    const w = buildHud(input({ activity: note, plan: mixed }), null);
    expect(w.panel?.title).toBe("TRADE");
    expect(w.route?.[0]).toMatchObject({ kind: "current" });
    // The jumps on the plotted route reach the panel.
    const nav = { systems: ["Kremainn", "Mid", "Wolf 397"] };
    const x = buildHud(input({ activity: note, plan: loop({ lap: 2 }), nav }), null);
    expect(x.panel?.rows.find((r) => r.text.startsWith("▸"))?.right).toMatch(/· 2 jumps$/);
    expect(x.route).toBeNull();
  });

  it("shows the route rows for a plotted route elsewhere, or once the plan is done", () => {
    // A route to a fuel stop, not one of the plan's: below, with its jumps, not on a stop's row.
    const nav = { systems: ["Kremainn", "Mid", "Fuel Star"] };
    const v = buildHud(input({ activity: note, plan: loop({ lap: 2 }), nav }), null);
    expect(v.route?.[0]).toMatchObject({ kind: "current", right: "2 jumps" });
    expect(v.panel?.rows.some((r) => r.right?.includes("jump"))).toBe(false);
    // The plan done, with cargo still aboard: the panel shows the hold; the route home shows.
    const plan = route([stop("Kremainn", "Wohler Terminal", [], "done")]);
    const events = [buy(5, "Gold", 5, 1)];
    const done = input({
      plan,
      nav: { systems: ["Kremainn", "Home"] },
      journal: journal({ cargo: hold({ Gold: 5 }) }, events),
    });
    const w = buildHud(done, null);
    expect(w.panel?.mode).toBe("trade");
    expect(w.route?.[0]).toMatchObject({ kind: "current", text: "Home", right: "1 jump" });
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
