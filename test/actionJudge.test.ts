import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalState, Plan } from "ed-mcp/journal";
import { hasActions, isBuildPlan, judgeBuild, type Action } from "../src/core/hud/buildJudge.js";

// The judge for the stop actions any plan can have: trade, missions and the station's services.

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const ev = (s: number, event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: iso(s),
  event,
  ...extra,
});

type ActionIn = Partial<Action> & Pick<Action, "id" | "kind">;
const act = (a: ActionIn): Action => ({ status: "todo", label: a.id, ...a }) as Action;

type Stop = Plan["stops"][number];
const stop = (actions: Action[], o: Partial<Stop> = {}): Stop =>
  ({
    system: "Sol",
    station: "Abraham Lincoln",
    purpose: "x",
    status: "todo",
    actions,
    ...o,
  }) as Stop;

let plans = 0;
// Each plan its own ID: the judge keeps one judgement per plan ID, keyed by its updated_at.
const plan = (stops: Stop[], o: Partial<Plan> = {}): Plan =>
  ({
    id: `p${++plans}`,
    name: "Plan",
    items: [],
    stops,
    started_at: iso(0),
    created_at: iso(-600),
    updated_at: iso(-600),
    ...o,
  }) as Plan;

type Journal = Parameters<typeof judgeBuild>[1];
const journal = (events: JournalEvent[], o: Partial<Journal> = {}): Journal => ({
  materials: { raw: [], manufactured: [], encoded: [] },
  engineers: [],
  events,
  ...o,
});

const done = (p: Plan, events: JournalEvent[], o: Partial<Journal> = {}) =>
  judgeBuild(p, journal(events, o)).actions.map((x) => x.done);

const docked = (s: number, station = "Abraham Lincoln", system = "Sol") =>
  ev(s, "Docked", { StarSystem: system, StationName: station, MarketID: 1 });
const market = (
  s: number,
  event: "MarketBuy" | "MarketSell",
  type: string,
  count: number,
  o = {},
) => ev(s, event, { Type: type, Count: count, MarketID: 1, ...o });

type Cargo = JournalState["cargo"][number];
const cargo = (name: string, count: number): Cargo =>
  ({ name, count, stolen: false, mission_id: null }) as Cargo;

describe("buys and sales", () => {
  const buy = (count: number, commodity = "Gold") =>
    act({ id: "buy", kind: "buy_commodity", commodity, count });

  it("adds up the market's tons to the count", () => {
    const p = plan([stop([buy(20)])]);
    expect(done(p, [docked(1), market(2, "MarketBuy", "gold", 15)])).toEqual([false]);
    expect(
      done(p, [docked(1), market(2, "MarketBuy", "gold", 15), market(3, "MarketBuy", "gold", 5)]),
    ).toEqual([true]);
  });

  it("does not count stolen goods sold", () => {
    const p = plan([
      stop([act({ id: "sell", kind: "sell_commodity", commodity: "Gold", count: 10 })]),
    ]);
    expect(
      done(p, [docked(1), market(2, "MarketSell", "gold", 10, { StolenGoods: true })]),
    ).toEqual([false]);
    expect(
      done(p, [docked(1), market(2, "MarketSell", "gold", 10, { StolenGoods: false })]),
    ).toEqual([true]);
  });

  it("writes the tons each event gave, in done_by", () => {
    const p = plan([stop([buy(20)])]);
    const j = judgeBuild(
      p,
      journal([docked(1), market(2, "MarketBuy", "gold", 15), market(3, "MarketBuy", "gold", 9)]),
    );
    expect(j.actions[0]!.write?.done_by?.map((c) => c.amount)).toEqual([15, 5]);
  });

  it("matches the game's name or the internal one, whatever the case", () => {
    const p = plan([stop([buy(10, "Agri-Medicines")])]);
    const local = market(2, "MarketBuy", "agriculturalmedicines", 10, {
      Type_Localised: "Agri-Medicines",
    });
    expect(done(p, [docked(1), local])).toEqual([true]);
    // A client in another language: only the internal name matches the plan's English one.
    const other = market(2, "MarketBuy", "agriculturalmedicines", 10, {
      Type_Localised: "Agrarmedikamente",
    });
    expect(done(p, [docked(1), other])).toEqual([true]);
    expect(
      done(plan([stop([buy(10, "GOLD")])]), [docked(1), market(2, "MarketBuy", "Gold", 10)]),
    ).toEqual([true]);
  });

  it("counts a trade only at the stop's station", () => {
    const p = plan([stop([buy(10)])]);
    expect(done(p, [docked(1, "Elsewhere"), market(2, "MarketBuy", "gold", 10)])).toEqual([false]);
    // Undocked and docked again at the stop.
    expect(
      done(p, [
        docked(1, "Elsewhere"),
        ev(2, "Undocked", { StationName: "Elsewhere" }),
        docked(3),
        market(4, "MarketBuy", "gold", 10),
      ]),
    ).toEqual([true]);
    // A stop with no station stands for its system.
    expect(
      done(plan([stop([buy(10)], { station: undefined })]), [
        docked(1, "Elsewhere"),
        market(2, "MarketBuy", "gold", 10),
      ]),
    ).toEqual([true]);
    // Where the ship is is not in the events yet: it is no stop.
    expect(done(p, [market(2, "MarketBuy", "gold", 10)])).toEqual([false]);
  });

  it("knows a game restarted while docked from its Location", () => {
    const p = plan([stop([buy(10)])]);
    const here = ev(1, "Location", {
      StarSystem: "Sol",
      StationName: "Abraham Lincoln",
      Docked: true,
    });
    expect(done(p, [here, market(2, "MarketBuy", "gold", 10)])).toEqual([true]);
    const there = ev(1, "Location", { StarSystem: "Sol", StationName: "Other", Docked: true });
    expect(done(plan([stop([buy(10)])]), [there, market(2, "MarketBuy", "gold", 10)])).toEqual([
      false,
    ]);
  });

  it("shares one sale between two sale actions in plan order, then the rest to the next stop's", () => {
    const sell = (id: string, count: number) =>
      act({ id, kind: "sell_commodity", commodity: "Gold", count });
    const p = plan([stop([sell("a", 6), sell("b", 6)])]);
    const j = judgeBuild(p, journal([docked(1), market(2, "MarketSell", "gold", 8)]));
    expect(j.actions.map((x) => [x.done, x.taken])).toEqual([
      [true, 6],
      [false, 2],
    ]);
  });

  it("finishes a buy that filled the hold, and a sale that left none aboard", () => {
    const p = plan([
      stop([buy(100), act({ id: "sell", kind: "sell_commodity", commodity: "Silver", count: 50 })]),
    ]);
    const events = [
      docked(1),
      market(2, "MarketSell", "silver", 40),
      market(3, "MarketBuy", "gold", 96),
    ];
    const ship = { id: 1, type: "python", cargo_capacity: 100 };
    // 4 t of limpets and 96 t of gold fill the hold; the 40 t sold were all the silver.
    expect(done(p, events, { ship, cargo: [cargo("Gold", 96), cargo("drones", 4)] })).toEqual([
      true,
      true,
    ]);
    // Room left and silver still aboard: neither is done.
    expect(done(p, events, { ship, cargo: [cargo("Gold", 90), cargo("Silver", 2)] })).toEqual([
      false,
      false,
    ]);
    // Nothing bought or sold yet: an empty hold does not finish a sale.
    expect(done(p, [docked(1)], { ship, cargo: [] })).toEqual([false, false]);
  });
});

describe("the hold, only while still docked where it was bought or sold", () => {
  const ship = { id: 1, type: "python", cargo_capacity: 100 };
  const p = () =>
    plan([stop([act({ id: "buy", kind: "buy_commodity", commodity: "Gold", count: 100 })])]);
  const bought = [docked(1), market(2, "MarketBuy", "gold", 96)];
  const full = { ship, cargo: [cargo("Gold", 96), cargo("drones", 4)] };

  it("finishes a short buy while docked there", () => {
    expect(done(p(), bought, full)).toEqual([true]);
  });

  it("does not finish it when the full hold has none of the goods aboard", () => {
    const other = { ship, cargo: [cargo("Silver", 100)] };
    expect(done(p(), bought, other)).toEqual([false]);
  });

  it("does not take a hold of 0 t as full", () => {
    const none = { ship: { ...ship, cargo_capacity: 0 }, cargo: [cargo("Gold", 1)] };
    expect(done(p(), [docked(1), market(2, "MarketBuy", "gold", 1)], none)).toEqual([false]);
  });

  it("does not finish it once the ship left, though the hold is full", () => {
    const left = [...bought, ev(3, "Undocked", { StationName: "Abraham Lincoln" })];
    expect(done(p(), left, full)).toEqual([false]);
    // Docked there again: another docking, and its buys are not the hold that filled.
    expect(done(p(), [...left, docked(4)], full)).toEqual([false]);
    // A relog while docked is the same docking.
    const relog = ev(3, "Location", {
      StarSystem: "Sol",
      StationName: "Abraham Lincoln",
      Docked: true,
    });
    expect(done(p(), [...bought, relog], full)).toEqual([true]);
  });
});

describe("a loop's lap", () => {
  it("counts the events after the lap began, not the one at its start", () => {
    // Lap 1 ended with a sale at 10, and ed-mcp started lap 2 at that sale's time.
    const lap2 = plan(
      [
        stop([act({ id: "sell", kind: "sell_commodity", commodity: "Gold", count: 10 })]),
        stop([act({ id: "buy", kind: "buy_commodity", commodity: "Silver", count: 10 })], {
          station: "Other",
        }),
      ],
      { repeat: true, lap: 2, started_at: iso(10) },
    );
    const events = [
      docked(5, "Other"),
      market(10, "MarketBuy", "silver", 10),
      docked(20),
      market(21, "MarketSell", "gold", 10),
    ];
    // The buy at 10 was lap 1's, not lap 2's.
    expect(done(lap2, events)).toEqual([true, false]);
  });

  it("writes a hand mark again on the next lap", () => {
    const at = (lap: number, started: number) => {
      const p = plan([stop([act({ id: "f", kind: "refuel", status: "done" })])], {
        id: "laps",
        repeat: true,
        lap,
        started_at: iso(started),
        updated_at: iso(100),
      });
      return judgeBuild(p, journal([docked(1), ev(50, "RefuelAll")])).actions[0]!.write?.key;
    };
    expect(at(1, 0)).not.toEqual(at(2, 30));
  });
});

describe("missions", () => {
  const MISSION = 900;
  const depot = (s: number, type: "Collect" | "Deliver", count: number, so: number, total = 20) =>
    ev(s, "CargoDepot", {
      MissionID: MISSION,
      UpdateType: type,
      Count: count,
      ItemsCollected: type === "Collect" ? so : 0,
      ItemsDelivered: type === "Deliver" ? so : 0,
      TotalItemsToDeliver: total,
    });

  it("completes a mission by its ID", () => {
    const p = plan([stop([act({ id: "c", kind: "complete_mission", mission_id: MISSION })])]);
    expect(done(p, [ev(1, "MissionCompleted", { MissionID: 1 })])).toEqual([false]);
    // Wherever it is handed in: the ID says which mission it is.
    expect(
      done(p, [docked(1, "Elsewhere"), ev(2, "MissionCompleted", { MissionID: MISSION })]),
    ).toEqual([true]);
  });

  it("adds up a delivery's cargo, and takes a depot showing all of it delivered as done", () => {
    const deliver = (count?: number) =>
      act({ id: "d", kind: "deliver_cargo", mission_id: MISSION, ...(count ? { count } : {}) });
    expect(done(plan([stop([deliver(12)])]), [depot(1, "Deliver", 8, 16)])).toEqual([false]);
    expect(
      done(plan([stop([deliver(12)])]), [depot(1, "Deliver", 8, 16), depot(2, "Deliver", 4, 20)]),
    ).toEqual([true]);
    // With no count, only the depot showing all of it delivered.
    expect(done(plan([stop([deliver()])]), [depot(1, "Deliver", 8, 16)])).toEqual([false]);
    expect(done(plan([stop([deliver()])]), [depot(1, "Deliver", 4, 20)])).toEqual([true]);
    // A collection is not a delivery, and another mission's is not this one's.
    expect(done(plan([stop([deliver(4)])]), [depot(1, "Collect", 4, 4)])).toEqual([false]);
    expect(
      done(plan([stop([deliver(4)])]), [
        ev(1, "CargoDepot", { MissionID: 1, UpdateType: "Deliver", Count: 4 }),
      ]),
    ).toEqual([false]);
  });

  it("collects cargo from a depot", () => {
    const p = plan([
      stop([act({ id: "c", kind: "collect_cargo", mission_id: MISSION, count: 8 })]),
    ]);
    expect(done(p, [depot(1, "Collect", 8, 8)])).toEqual([true]);
  });
});

describe("the station's services", () => {
  it("sells exploration or organic data", () => {
    const data = (d?: "exploration" | "organic") =>
      plan([stop([act({ id: "d", kind: "sell_data", ...(d ? { data: d } : {}) })])]);
    const organic = [docked(1), ev(2, "SellOrganicData", { BioData: [] })];
    const carto = [docked(1), ev(2, "MultiSellExplorationData", { Discovered: [] })];
    expect(done(data("organic"), organic)).toEqual([true]);
    expect(done(data("organic"), carto)).toEqual([false]);
    expect(done(data("exploration"), carto)).toEqual([true]);
    expect(done(data(), organic)).toEqual([true]);
  });

  it("redeems the kind of voucher asked for", () => {
    const vouchers = (v: "bounty" | "combat_bond") =>
      plan([stop([act({ id: "v", kind: "redeem_vouchers", voucher: v })])]);
    const bond = [docked(1), ev(2, "RedeemVoucher", { Type: "CombatBond", Amount: 1 })];
    expect(done(vouchers("combat_bond"), bond)).toEqual([true]);
    expect(done(vouchers("bounty"), bond)).toEqual([false]);
  });

  it("refuels, repairs and restocks, at the stop", () => {
    const p = plan([
      stop([
        act({ id: "f", kind: "refuel" }),
        act({ id: "r", kind: "repair" }),
        act({ id: "a", kind: "restock" }),
      ]),
    ]);
    const events = [
      docked(1),
      ev(2, "RefuelPartial", { Amount: 4 }),
      ev(3, "RepairAll", { Cost: 10 }),
      ev(4, "BuyAmmo", { Cost: 10 }),
    ];
    expect(done(p, events)).toEqual([true, true, true]);
    expect(done({ ...p, id: "elsewhere" }, [docked(1, "Elsewhere"), ...events.slice(1)])).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("when an action counts from", () => {
  const refuel = (o: Partial<Action> = {}) => act({ id: "f", kind: "refuel", ...o });
  const at = (s: number) => [docked(s - 1), ev(s, "RefuelAll")];

  it("is the action's own started_at, then the build's, then the plan's, then when it was made", () => {
    // The plan started at 0: a refuel before then is not this plan's.
    expect(done(plan([stop([refuel()])]), at(-10))).toEqual([false]);
    expect(done(plan([stop([refuel()])]), at(10))).toEqual([true]);
    // The action's own start is later.
    expect(done(plan([stop([refuel({ started_at: iso(60) })])]), at(10))).toEqual([false]);
    expect(done(plan([stop([refuel({ started_at: iso(60) })])]), at(70))).toEqual([true]);
    // The build's start comes before the plan's.
    const build = { target: "ship", scope: "full", started_at: iso(30) } as Plan["build"];
    expect(done(plan([stop([refuel()])], { build }), at(10))).toEqual([false]);
    // With no start at all, when the plan was made.
    expect(done(plan([stop([refuel()])], { started_at: undefined }), at(-300))).toEqual([true]);
    expect(done(plan([stop([refuel()])], { started_at: undefined }), at(-900))).toEqual([false]);
  });
});

describe("which plans", () => {
  const trade = plan([
    stop([act({ id: "b", kind: "buy_commodity", commodity: "Gold", count: 1 })]),
  ]);

  it("follows a build only for a plan with a build, or a build's kinds of action", () => {
    expect(hasActions(trade)).toBe(true);
    expect(isBuildPlan(trade)).toBe(false);
    const missions = plan([stop([act({ id: "c", kind: "complete_mission", mission_id: 1 })])]);
    expect(isBuildPlan(missions)).toBe(false);
    const build = { target: "ship", scope: "upgrade" } as Plan["build"];
    expect(isBuildPlan({ ...trade, build })).toBe(true);
    const shop = plan([stop([act({ id: "m", kind: "buy_module", module: "x" })])]);
    expect(isBuildPlan(shop)).toBe(true);
    expect(hasActions(plan([stop([])]))).toBe(false);
  });
});
