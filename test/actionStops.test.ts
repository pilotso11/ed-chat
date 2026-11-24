import { describe, expect, it } from "vitest";
import type { Activity, ActionPatch, JournalEvent, JournalState, Plan } from "ed-mcp/journal";
import { ActionFinisher, finisherPanel, nextSystem } from "../src/core/hud/actionStops.js";

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const ev = (s: number, event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: iso(s),
  event,
  ...extra,
});

const KRAIT = 12;
const PYTHON = 30;
const BOOSTER = "$hpt_shieldbooster_size0_class5_name;";

/** Two shop stops: two boosters at Port, then a sale at Far. */
const plan = (o: Partial<Plan> = {}): Plan =>
  ({
    id: "krait",
    name: "Krait build",
    items: [],
    build: {
      target: "ship",
      scope: "full",
      ship: "krait_mkii",
      ship_id: KRAIT,
      started_at: iso(0),
    },
    stops: [
      {
        system: "S",
        station: "Port",
        purpose: "Boosters",
        kind: "shop",
        status: "todo",
        actions: ["b1", "b2"].map((id) => ({
          id,
          kind: "buy_module",
          label: "Buy Shield Booster 0A",
          status: "todo",
          module: "hpt_shieldbooster_size0_class5",
        })),
      },
      {
        system: "Far",
        station: "Hub",
        purpose: "Sell",
        kind: "shop",
        status: "todo",
        actions: [
          {
            id: "s1",
            kind: "sell_module",
            label: "Sell AFM",
            status: "todo",
            module: "int_repairer_size2_class1",
          },
        ],
      },
      { system: "Far", purpose: "Fuel", kind: "fuel", status: "todo" },
    ],
    created_at: iso(-60),
    updated_at: iso(-60),
    ...o,
  }) as Plan;

type Journal = JournalState & { events: JournalEvent[] };
const journal = (events: JournalEvent[], ship = KRAIT, type = "krait_mkii"): Journal =>
  ({
    location: {
      system: "S",
      station: "Port",
      station_type: null,
      docked: true,
      dist_from_star_ls: null,
    },
    ship: { type, id: ship, cargo_capacity: null },
    cargo: [],
    materials: { raw: [], manufactured: [], encoded: [] },
    missions: [],
    engineers: [],
    stored_modules: null,
    events: [ev(1, "Docked", { StarSystem: "S", StationName: "Port", MarketID: 1 }), ...events],
  }) as unknown as Journal;
const buy = (s: number, ship = KRAIT) =>
  ev(s, "ModuleBuy", {
    Slot: "TinyHardpoint1",
    BuyItem: BOOSTER,
    Ship: "krait_mkii",
    ShipID: ship,
  });

function setup(start = plan(), o: { activity?: Activity | null; fail?: boolean } = {}) {
  const log = {
    copies: [] as string[],
    notices: [] as string[],
    warnings: [] as string[],
    writes: [] as string[],
    notes: [] as unknown[],
    /** The lapStart given with each stop marked. */
    laps: [] as (string | undefined)[],
  };
  const store = new Map<string, Plan>([[start.id, start]]);
  let stopFails = false;
  const touch = (p: Plan): Plan => ({ ...p, updated_at: iso(1000 + log.writes.length) });
  const plans = {
    get: async (id: string) => {
      const p = store.get(id);
      if (!p) throw new Error(`Plan "${id}" not found`);
      return structuredClone(p);
    },
    updateAction: async (
      id: string,
      ref: { stop: { index?: number }; action: string },
      patch: ActionPatch,
    ) => {
      if (o.fail) throw new Error("locked");
      log.writes.push(`${id}:${ref.stop.index}:${ref.action}:${JSON.stringify(patch)}`);
      const p = structuredClone(store.get(id)!);
      const a = p.stops[ref.stop.index!]!.actions!.find((x) => x.id === ref.action)!;
      Object.assign(a, patch);
      store.set(id, touch(p));
      return structuredClone(store.get(id)!);
    },
    updateStop: async (
      id: string,
      ref: { index?: number },
      patch: { status?: Plan["stops"][number]["status"] },
      opts?: { lapStart?: string },
    ) => {
      if (stopFails) throw new Error("stop locked");
      log.laps.push(opts?.lapStart);
      log.writes.push(`${id}:stop ${ref.index}:${patch.status}`);
      const p = structuredClone(store.get(id)!);
      Object.assign(p.stops[ref.index!]!, patch);
      store.set(id, touch(p));
      return structuredClone(store.get(id)!);
    },
    setBuildShip: async (id: string, ship: number) => {
      log.writes.push(`${id}:ship ${ship}`);
      const p = structuredClone(store.get(id)!);
      p.build = { ...p.build!, ship_id: ship };
      store.set(id, touch(p));
      return structuredClone(store.get(id)!);
    },
  };
  let note: Activity | null = o.activity ?? null;
  let notesClosed = false;
  const activity = {
    get: async () => note,
    set: async (input: { kind: Activity["kind"]; summary: string; plan_id?: string }) => {
      log.notes.push(input);
      note = { ...input, updated_at: iso(2000) };
      return note;
    },
  };
  const finisher = new ActionFinisher({
    plans: () => plans as never,
    activity: () => (notesClosed ? null : (activity as never)),
    copy: (system, n) => log.copies.push(`${system}: ${n}`),
    notice: (t) => log.notices.push(t),
    warn: (m) => log.warnings.push(m),
  });
  const poll = (j: Journal, others: Plan[] = [], on?: (p: Plan) => boolean) =>
    finisher.finish({
      note: store.get(start.id)!,
      plans: others.map((p) => store.get(p.id) ?? p),
      journal: j,
      activity: note,
      ...(on ? { on } : {}),
    });
  return {
    log,
    store,
    poll,
    finisher,
    add: (p: Plan) => store.set(p.id, p),
    failStop: (on: boolean) => (stopFails = on),
    closeNotes: (on: boolean) => (notesClosed = on),
  };
}

describe("the stop copied after one is done", () => {
  const stops = (...s: [string, "todo" | "done"][]) =>
    plan({ stops: s.map(([system, status]) => ({ system, purpose: system, status })) });

  it("is the next open stop after it, not an earlier one still open", () => {
    // Stop 0 is still open behind you; stop 1 was just finished.
    expect(nextSystem(stops(["A", "todo"], ["B", "done"], ["C", "todo"]), 1, "B")).toBe("C");
  });

  it("wraps round to an earlier open stop when none come after", () => {
    expect(nextSystem(stops(["A", "todo"], ["B", "done"]), 1, "B")).toBe("A");
    expect(nextSystem(stops(["A", "done"], ["B", "done"]), 1, "B")).toBeNull();
    // In this system already: nothing to copy.
    expect(nextSystem(stops(["B", "todo"], ["B", "done"]), 1, "B")).toBeNull();
  });
});

describe("ActionFinisher", () => {
  it("marks each action once with its done_by, and the stop on the change, copying the next", async () => {
    const t = setup();
    await t.poll(journal([]));
    expect(t.log.writes).toEqual([]);
    await t.poll(journal([buy(5)]));
    expect(t.log.writes).toEqual([
      `krait:0:b1:${JSON.stringify({ status: "done", done_by: [{ at: iso(5), event: "ModuleBuy", n: 0, role: "bought" }] })}`,
    ]);
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.slice(1)).toEqual([
      `krait:0:b2:${JSON.stringify({ status: "done", done_by: [{ at: iso(6), event: "ModuleBuy", n: 0, role: "bought" }] })}`,
      "krait:stop 0:done",
    ]);
    expect(t.log.copies).toEqual(["Far: S · Port: done. Next stop copied: Far"]);
    // Polled again: nothing more.
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes).toHaveLength(3);
  });

  it("marks a stop its own writes finish on the first poll", async () => {
    const t = setup();
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual(["krait:stop 0:done"]);
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toHaveLength(1);
  });

  it("leaves a stop done before the first poll, or reopened, for a route key", async () => {
    // Both actions marked done already (ED Chat was off), and the stop reopened: not marked.
    const p = plan();
    for (const a of p.stops[0]!.actions!) Object.assign(a, { status: "done", done_by: [] });
    const t = setup(p);
    await t.poll(journal([]));
    await t.poll(journal([]));
    expect(t.log.writes).toEqual([]);
  });

  it("runs one finish at a time, so nothing is written or copied twice", async () => {
    const t = setup();
    await t.poll(journal([buy(5)]));
    const j = journal([buy(5), buy(6)]);
    await Promise.all([t.poll(j), t.poll(j), t.poll(j)]);
    expect(t.log.writes.filter((w) => w.includes(":b2:"))).toHaveLength(1);
    expect(t.log.writes.filter((w) => w.includes("stop 0"))).toHaveLength(1);
    expect(t.log.copies).toHaveLength(1);
  });

  it("tries a stop again when marking it failed", async () => {
    const t = setup();
    await t.poll(journal([buy(5)]));
    t.failStop(true);
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual([]);
    expect(t.log.warnings).toEqual(["stop locked"]);
    t.failStop(false);
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual(["krait:stop 0:done"]);
  });

  it("writes the swap's note on a later poll when the note's store was not open", async () => {
    const python = plan({
      id: "py",
      name: "Python build",
      build: { target: "ship", scope: "full", ship_id: PYTHON },
    });
    const activity: Activity = {
      kind: "engineering",
      summary: "Krait",
      plan_id: "krait",
      updated_at: iso(0),
    };
    const t = setup(plan(), { activity });
    t.add(python);
    await t.poll(journal([]), [python]);
    t.closeNotes(true);
    const swapped = journal(
      [ev(9, "ShipyardSwap", { ShipType: "python_nx", ShipID: PYTHON })],
      PYTHON,
      "python_nx",
    );
    await t.poll(swapped, [python]);
    expect(t.log.notes).toEqual([]);
    t.closeNotes(false);
    await t.poll(swapped, [python]);
    expect(t.log.notes).toEqual([{ kind: "engineering", summary: "Python build", plan_id: "py" }]);
  });

  it("goes on with the other plans when one fails", async () => {
    const t = setup();
    const broken = plan({ id: "broken" });
    // Not in the store: get() fails for it.
    await t.poll(journal([buy(5)]), [broken]);
    expect(t.log.warnings).toHaveLength(1);
    expect(t.log.writes.some((w) => w.startsWith("krait:0:b1"))).toBe(true);
  });

  it("marks a stop Claude finished by hand, but never a stop with no actions", async () => {
    const t = setup();
    await t.poll(journal([]));
    const p = structuredClone(t.store.get("krait")!);
    p.stops[1]!.actions![0]!.status = "done";
    p.stops[1]!.actions![0]!.done_by = [];
    p.updated_at = iso(500);
    t.add(p);
    await t.poll(journal([]));
    // Not the stop shown as current: marked quietly.
    expect(t.log.writes).toEqual(["krait:stop 1:done"]);
    expect(t.log.copies).toEqual([]);
  });

  it("does not mark done a stop whose actions were all skipped, as by /dismiss-plan all", async () => {
    const t = setup();
    await t.poll(journal([]));
    const p = structuredClone(t.store.get("krait")!);
    p.stops[1]!.actions![0]!.status = "skipped";
    p.updated_at = iso(500);
    t.add(p);
    await t.poll(journal([]));
    expect(t.log.writes).toEqual([]);
  });

  it("writes the ShipID found by type, once", async () => {
    const t = setup(
      plan({ build: { target: "ship", scope: "full", ship: "krait_mkii", started_at: iso(0) } }),
    );
    await t.poll(journal([buy(5)]));
    expect(t.log.writes.at(-1)).toBe(`krait:ship ${KRAIT}`);
    await t.poll(journal([buy(5)]));
    expect(t.log.writes.filter((w) => w.includes("ship"))).toHaveLength(1);
  });

  it("leaves a failed write for the next poll, and warns once", async () => {
    const t = setup(plan(), { fail: true });
    await t.poll(journal([buy(5)]));
    await t.poll(journal([buy(5)]));
    expect(t.log.warnings).toEqual(["locked"]);
  });

  it("skips a write the plan no longer asks for", async () => {
    const t = setup();
    // Claude skipped the action after the poll read the plan.
    const p = structuredClone(t.store.get("krait")!);
    p.stops[0]!.actions![0]!.status = "skipped";
    const stale = t.store.get("krait")!;
    t.add(p);
    await (t.finisher as ActionFinisher).finish({
      note: stale,
      plans: [],
      journal: journal([buy(5)]),
      activity: null,
    });
    // The buy went to b2 on the plan as it is now, which the stale judgement does not ask for.
    expect(t.log.writes).toEqual([]);
  });

  it("points the note at the new ship's plan on a ship swap", async () => {
    const python = plan({
      id: "py",
      name: "Python build",
      build: { target: "ship", scope: "full", ship_id: PYTHON },
    });
    const activity: Activity = {
      kind: "engineering",
      summary: "Krait",
      plan_id: "krait",
      updated_at: iso(0),
    };
    const t = setup(plan(), { activity });
    t.add(python);
    await t.poll(journal([]), [python]);
    await t.poll(
      journal(
        [ev(9, "ShipyardSwap", { ShipType: "python_nx", ShipID: PYTHON })],
        PYTHON,
        "python_nx",
      ),
      [python],
    );
    expect(t.log.notes).toEqual([{ kind: "engineering", summary: "Python build", plan_id: "py" }]);
    expect(t.log.notices).toEqual(["📋 Python build: now the activity note's plan"]);
  });

  it("does nothing before the stores are open", async () => {
    const f = new ActionFinisher({
      plans: () => null,
      activity: () => null,
      copy: () => {},
      notice: () => {},
      warn: () => {},
    });
    await expect(
      f.finish({ note: plan(), plans: [], journal: journal([]), activity: null }),
    ).resolves.toBeUndefined();
  });
});

describe("ActionFinisher on trade and mission plans", () => {
  type Stop = Plan["stops"][number];
  const tradeStop = (system: string, station: string, actions: Stop["actions"]): Stop =>
    ({
      system,
      station,
      purpose: `Trade at ${station}`,
      label: `Trade at ${station}`,
      kind: "trade",
      status: "todo",
      actions,
    }) as Stop;
  const goods = (kind: "buy_commodity" | "sell_commodity", count: number) => ({
    id: `${kind}-gold`,
    kind,
    label: `${kind} ${count} t Gold`,
    status: "todo" as const,
    commodity: "Gold",
    count,
  });
  /** A loop: buy gold at Port, sell it at Hub. */
  const loop = (o: Partial<Plan> = {}): Plan =>
    ({
      id: "loop",
      name: "Trade loop: S ⇄ Far",
      items: [],
      repeat: true,
      lap: 2,
      started_at: iso(0),
      stops: [
        tradeStop("S", "Port", [goods("buy_commodity", 10)]),
        tradeStop("Far", "Hub", [goods("sell_commodity", 10)]),
      ],
      created_at: iso(-60),
      updated_at: iso(-60),
      ...o,
    }) as Plan;
  const at = (system: string, station: string, events: JournalEvent[]): Journal => ({
    ...journal([]),
    location: { system, station, station_type: null, docked: true, dist_from_star_ls: null },
    events: [ev(1, "Docked", { StarSystem: system, StationName: station, MarketID: 1 }), ...events],
  });
  const market = (s: number, event: string, count: number) =>
    ev(s, event, { Type: "gold", Count: count, MarketID: 1 });

  it("ticks off the note's trade stop and copies the next, as the trade finisher did", async () => {
    const t = setup(loop());
    await t.poll(at("S", "Port", []));
    await t.poll(at("S", "Port", [market(5, "MarketBuy", 10)]));
    expect(t.log.writes).toEqual([
      `loop:0:buy_commodity-gold:${JSON.stringify({ status: "done", done_by: [{ at: iso(5), event: "MarketBuy", n: 0, role: "goods_bought", amount: 10 }] })}`,
      "loop:stop 0:done",
    ]);
    expect(t.log.copies).toEqual(["Far: Trade at Port: done. Next stop copied: Far"]);
    // The newest event's time goes with the stop, for the lap the last stop starts.
    expect(t.log.laps).toEqual([iso(5)]);
  });

  it("starts the next lap at the event that finished the stop, not at a newer one", async () => {
    const t = setup(loop());
    await t.poll(at("S", "Port", []));
    // The buy finished the stop; the undock after it came before the write.
    await t.poll(
      at("S", "Port", [market(5, "MarketBuy", 10), ev(8, "Undocked", { StationName: "Port" })]),
    );
    expect(t.log.laps).toEqual([iso(5)]);
  });

  it("starts the next lap at the lap's newest claim, at whichever stop it was", async () => {
    const t = setup(loop());
    await t.poll(at("Far", "Hub", []));
    // Sold at Far first, then bought at Port: both stops are marked in one poll.
    await t.poll(
      at("Far", "Hub", [
        market(5, "MarketSell", 10),
        ev(7, "Docked", { StarSystem: "S", StationName: "Port", MarketID: 1 }),
        market(8, "MarketBuy", 10),
      ]),
    );
    expect(t.log.laps).toEqual([iso(8), iso(8)]);
  });

  it("leaves a delivery run with trade stops to the route, not the trade setting", () => {
    expect(finisherPanel(plan())).toBe("build");
    expect(finisherPanel(loop())).toBe("trade");
    const deliver = {
      id: "d",
      kind: "deliver_cargo",
      label: "Deliver",
      status: "todo",
      mission_id: 1,
    };
    const run = loop({ stops: [tradeStop("Far", "Hub", [deliver as never])] });
    expect(finisherPanel(run)).toBeNull();
  });

  it("gives the store's newest event time as the lap start of a stop with no claim, read once a poll", async () => {
    const t = setup(loop());
    let reads = 0;
    const f = new ActionFinisher({
      plans: () =>
        ({
          get: async () => loop(),
          // The buy and the sale written: neither stop has anything left to do.
          updateAction: async () => {
            const p = loop();
            for (const s of p.stops) s.actions![0]!.status = "done";
            return p;
          },
          updateStop: async (
            _id: string,
            _ref: unknown,
            _p: unknown,
            o?: { lapStart?: string },
          ) => {
            t.log.laps.push(o?.lapStart);
            return loop({ stops: loop().stops.map((s) => ({ ...s, status: "done" })) });
          },
          setBuildShip: async () => loop(),
        }) as never,
      activity: () => null,
      newestEventAt: async () => (reads++, iso(99)),
      copy: () => {},
      notice: () => {},
      warn: () => {},
    });
    // Bought at Port, then sold at Hub: both stops are marked in one poll.
    const j = at("Far", "Hub", [
      ev(2, "Docked", { StarSystem: "S", StationName: "Port", MarketID: 1 }),
      market(5, "MarketBuy", 10),
      ev(6, "Docked", { StarSystem: "Far", StationName: "Hub", MarketID: 1 }),
      market(7, "MarketSell", 10),
    ]);
    await f.finish({ note: loop(), plans: [], journal: j, activity: null });
    expect(t.log.laps).toEqual([iso(99), iso(99)]);
    expect(reads).toBe(1);
  });

  it("marks a stop whose only open action is one the judge cannot see done", async () => {
    const accept = { id: "take", kind: "accept_mission", label: "Take", status: "todo" };
    const p = loop();
    p.stops[0]!.actions!.unshift(accept as never);
    const t = setup(p);
    await t.poll(at("S", "Port", []));
    await t.poll(at("S", "Port", [market(5, "MarketBuy", 10)]));
    expect(t.log.writes).toContain("loop:stop 0:done");
  });

  it("leaves a suit loadout's plan alone, and writes no ship for a plan that is not a ship build", async () => {
    const suit = loop({
      id: "suit",
      build: { target: "suit_loadout", scope: "upgrade" },
    } as Partial<Plan>);
    const t = setup(suit);
    await t.poll(at("S", "Port", []));
    await t.poll(at("S", "Port", [market(5, "MarketBuy", 10)]));
    expect(t.log.writes).toEqual([]);
  });

  it("leaves an open trade plan alone unless it is the note's", async () => {
    const t = setup(plan());
    const old = loop({ id: "old" });
    t.add(old);
    await t.poll(at("S", "Port", []), [old]);
    await t.poll(at("S", "Port", [market(5, "MarketBuy", 10)]), [old]);
    expect(t.log.writes.filter((w) => w.startsWith("old"))).toEqual([]);
  });

  it("leaves a plan whose panel is off alone", async () => {
    const t = setup(loop());
    const off = () => false;
    await t.poll(at("S", "Port", []), [], off);
    await t.poll(at("S", "Port", [market(5, "MarketBuy", 10)]), [], off);
    expect(t.log.writes).toEqual([]);
  });

  it("marks a mission stop done when its missions are handed in", async () => {
    const run = {
      id: "run",
      name: "Mission run",
      items: [],
      started_at: iso(0),
      stops: [
        {
          system: "S",
          station: "Port",
          purpose: "Hand in",
          kind: "mission",
          status: "todo",
          missions: [7, 8],
          actions: [7, 8].map((id) => ({
            id: `complete-${id}`,
            kind: "complete_mission",
            label: `Hand in ${id}`,
            status: "todo",
            mission_id: id,
          })),
        },
        { system: "Far", station: "Hub", purpose: "Next", kind: "mission", status: "todo" },
      ],
      created_at: iso(-60),
      updated_at: iso(-60),
    } as unknown as Plan;
    const t = setup(run);
    const done = (s: number, id: number) => ev(s, "MissionCompleted", { MissionID: id });
    await t.poll(at("S", "Port", [done(5, 7)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual([]);
    await t.poll(at("S", "Port", [done(5, 7), done(6, 8)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual(["run:stop 0:done"]);
    expect(t.log.copies).toEqual(["Far: S · Port: done. Next stop copied: Far"]);
  });
});
