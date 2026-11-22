import { describe, expect, it } from "vitest";
import type { Activity, ActionPatch, JournalEvent, JournalState, Plan } from "ed-mcp/journal";
import { BuildFinisher } from "../src/core/hud/buildStops.js";

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
  };
  const store = new Map<string, Plan>([[start.id, start]]);
  const touch = (p: Plan): Plan => ({ ...p, updated_at: iso(1000 + log.writes.length) });
  const plans = {
    get: async (id: string) => structuredClone(store.get(id)!),
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
    ) => {
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
  const activity = {
    get: async () => note,
    set: async (input: { kind: Activity["kind"]; summary: string; plan_id?: string }) => {
      log.notes.push(input);
      note = { ...input, updated_at: iso(2000) };
      return note;
    },
  };
  const finisher = new BuildFinisher({
    plans: () => plans as never,
    activity: () => activity as never,
    copy: (system, n) => log.copies.push(`${system}: ${n}`),
    notice: (t) => log.notices.push(t),
    warn: (m) => log.warnings.push(m),
  });
  const poll = (j: Journal, others: Plan[] = []) =>
    finisher.finish({
      note: store.get(start.id)!,
      plans: others.map((p) => store.get(p.id) ?? p),
      journal: j,
      activity: note,
    });
  return { log, store, poll, finisher, add: (p: Plan) => store.set(p.id, p) };
}

describe("BuildFinisher", () => {
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

  it("marks nothing on the first poll's stops, and leaves a reopened stop open", async () => {
    const t = setup();
    // Both buys already in the journal at start: the actions are marked, the stop is not.
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual([]);
    await t.poll(journal([buy(5), buy(6)]));
    expect(t.log.writes.filter((w) => w.includes("stop"))).toEqual([]);
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
    await (t.finisher as BuildFinisher).finish({
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
    expect(t.log.notes).toEqual([{ kind: "engineering", summary: "Krait", plan_id: "py" }]);
    expect(t.log.notices).toEqual(["📋 Python build: now the activity note's plan"]);
  });

  it("does nothing before the stores are open", async () => {
    const f = new BuildFinisher({
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
