import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalState, Plan } from "ed-mcp/journal";
import { TradeStopFinisher, type TradeStopDeps } from "../src/core/hud/tradeStops.js";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const at = (m: number, event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: new Date(NOW - m * 60_000).toISOString(),
  event,
  ...extra,
});

/** Buy 10 t of gold at Port, then sell it at Far. */
const plan = (o: Partial<Plan> = {}): Plan =>
  ({
    id: "trade",
    name: "Trade route: S → Far",
    items: [],
    stops: [
      {
        system: "S",
        station: "Port",
        purpose: "Buy 10 t Gold",
        label: "Buy 10 t Gold at Port",
        kind: "trade",
        status: "todo",
        cargo: [{ commodity: "Gold", action: "buy", amount: 10 }],
      },
      {
        system: "Far",
        station: "Hub",
        purpose: "Sell 10 t Gold",
        kind: "trade",
        status: "todo",
        cargo: [{ commodity: "Gold", action: "sell", amount: 10 }],
      },
    ],
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...o,
  }) as Plan;

/** Docked at Port with the gold bought. */
const journal = {
  location: {
    system: "S",
    station: "Port",
    station_type: null,
    docked: true,
    dist_from_star_ls: null,
  },
  ship: { cargo_capacity: 100 },
  cargo: [{ name: "Gold", count: 10, stolen: false, mission_id: null }],
  missions: [],
  events: [
    at(10, "Docked", { StarSystem: "S", StationName: "Port", MarketID: 7 }),
    at(5, "MarketBuy", { MarketID: 7, Type: "gold", Count: 10, BuyPrice: 1, TotalCost: 10 }),
  ],
} as unknown as JournalState & { events: JournalEvent[] };

function setup(store: Partial<ReturnType<TradeStopDeps["plans"]> & object> = {}) {
  const log = {
    copies: [] as string[],
    notices: [] as string[],
    warnings: [] as string[],
    updates: 0,
  };
  let current = plan();
  const plans = {
    get: async () => current,
    updateStop: async (_id: string, ref: { index?: number }) => {
      log.updates++;
      current = {
        ...current,
        stops: current.stops.map((s, i) =>
          i === ref.index ? { ...s, status: "done" as const } : s,
        ),
      };
      return current;
    },
    ...store,
  };
  const finisher = new TradeStopFinisher({
    plans: () => plans as never,
    copy: (system) => log.copies.push(system),
    notice: (t) => log.notices.push(t),
    warn: (m) => log.warnings.push(m),
  });
  return { finisher, log, set: (p: Plan) => (current = p) };
}

describe("marking a trade stop done", () => {
  it("marks the stop done and copies the next stop's system once", async () => {
    const { finisher, log } = setup();
    await finisher.finish(plan(), journal);
    expect(log.updates).toBe(1);
    expect(log.copies).toEqual(["Far"]);
    // The next poll, before the plan read shows the change: not again.
    await finisher.finish(plan(), journal);
    expect(log.updates).toBe(1);
    expect(log.copies).toEqual(["Far"]);
  });

  it("leaves the stop open, to judge again, when the plan changed after the poll", async () => {
    const { finisher, log, set } = setup();
    // Claude replaced the plan: the stop is no longer to do.
    const changed = plan();
    set({ ...changed, stops: changed.stops.map((s) => ({ ...s, status: "skipped" as const })) });
    await finisher.finish(plan(), journal);
    expect(log.updates).toBe(0);
    // Changed back: the key was released, so it is judged again and marked.
    set(plan());
    await finisher.finish(plan(), journal);
    expect(log.updates).toBe(1);
  });

  it("releases the stop when the update fails, and logs the error once", async () => {
    let fail = true;
    const { finisher, log } = setup({
      updateStop: async () => {
        if (fail) throw new Error("locked");
        return plan({
          stops: plan().stops.map((s, i) => (i === 0 ? { ...s, status: "done" as const } : s)),
        });
      },
    });
    await finisher.finish(plan(), journal);
    await finisher.finish(plan(), journal);
    expect(log.warnings).toEqual(["locked"]);
    expect(log.copies).toEqual([]);
    fail = false;
    await finisher.finish(plan(), journal);
    expect(log.copies).toEqual(["Far"]);
    // After a success, the same error is new again.
    fail = true;
    // Docked again later: a new visit, so a new key.
    const again = {
      ...journal,
      events: [
        ...journal.events,
        at(3, "Undocked"),
        at(2, "Docked", { StarSystem: "S", StationName: "Port", MarketID: 7 }),
        at(1, "MarketBuy", { MarketID: 7, Type: "gold", Count: 10, BuyPrice: 1, TotalCost: 10 }),
      ],
    };
    await finisher.finish(plan(), again);
    expect(log.warnings).toEqual(["locked", "locked"]);
  });

  it("says the stop is done when the next stop is in this system, or the route is finished", async () => {
    const last = plan();
    const one = { ...last, stops: [last.stops[0]!] };
    const { finisher, log } = setup({
      get: async () => one,
      updateStop: async () => ({ ...one, stops: [{ ...one.stops[0]!, status: "done" as const }] }),
    });
    await finisher.finish(one, journal);
    expect(log.notices).toEqual(["✓ Buy 10 t Gold at Port: done"]);
  });

  it("does nothing with no store, plan or journal, or nothing done", async () => {
    const { log } = setup();
    const none = new TradeStopFinisher({
      plans: () => null,
      copy: () => log.copies.push("x"),
      notice: () => {},
      warn: () => {},
    });
    await none.finish(plan(), journal);
    const { finisher } = setup();
    await finisher.finish(null, journal);
    await finisher.finish(plan(), null);
    await finisher.finish(plan(), { ...journal, cargo: [] });
    expect(log.copies).toEqual([]);
  });
});
