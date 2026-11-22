import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalState, Plan } from "ed-mcp/journal";
import {
  atBuildStop,
  buildNow,
  buildPanel,
  chooseBuild,
  landedAt,
  parseOutfitting,
  shipName,
} from "../src/core/hud/build.js";
import {
  isBuildPlan,
  judgeBuild,
  materialsLeft,
  rollsLeft,
  type Action,
} from "../src/core/hud/buildJudge.js";
import { buildHud, currentMode, type HudInput } from "../src/core/hud/hud.js";
import { journalMode, noteMode } from "../src/core/hud/mode.js";
import { gameContext } from "../src/core/hud/context.js";
import { routeStep } from "../src/core/hud/routeSteps.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

// Times in seconds after the plan's start.
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const ev = (s: number, event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: iso(s),
  event,
  ...extra,
});

const KRAIT = 12;
const PYTHON = 30;

type ActionIn = Partial<Action> & Pick<Action, "id" | "kind" | "label">;
const act = (a: ActionIn): Action => ({ status: "todo", ...a }) as Action;

/** The FSD's materials per roll, from ed-mcp's catalog (FSD_LongRange). */
const FSD_BY_GRADE = {
  "3": {
    materials: [
      { name: "Chemical Processors", symbol: "ChemicalProcessors", count: 1 },
      { name: "Phosphorus", symbol: "Phosphorus", count: 1 },
      { name: "Strange Wake Solutions", symbol: "WakeSolutions", count: 1 },
    ],
  },
  "4": {
    materials: [
      { name: "Chemical Distillery", symbol: "ChemicalDistillery", count: 1 },
      { name: "Eccentric Hyperspace Trajectories", symbol: "HyperspaceTrajectories", count: 1 },
      { name: "Manganese", symbol: "Manganese", count: 1 },
    ],
  },
  "5": {
    materials: [
      { name: "Arsenic", symbol: "Arsenic", count: 1 },
      { name: "Chemical Manipulators", symbol: "ChemicalManipulators", count: 1 },
      { name: "Datamined Wake Exceptions", symbol: "DataminedWake", count: 1 },
    ],
  },
};

/** An upgrade of the Krait: a trade, Farseer for the FSD, Palin for the thrusters. */
const upgrade = (o: Partial<Plan> = {}, stops?: Plan["stops"]): Plan =>
  ({
    id: "krait",
    name: "Krait upgrade",
    items: [],
    build: {
      target: "ship",
      scope: "upgrade",
      ship: "krait_mkii",
      ship_id: KRAIT,
      started_at: iso(0),
      summary: "FSD G5 · thrusters Dirty G5",
    },
    stops: stops ?? [
      {
        system: "Jotunheim",
        station: "Gaspar de Lemos Ring",
        purpose: "Trade",
        kind: "trader",
        status: "todo",
        actions: [
          act({
            id: "t1",
            kind: "trade_material",
            label: "Trade 6 Eccentric Hyperspace Trajectories → 1 Datamined Wake Exceptions",
            paid: { material: "Eccentric Hyperspace Trajectories", count: 6 },
            received: { material: "Datamined Wake Exceptions", count: 1 },
          }),
        ],
      },
      {
        system: "Deciat",
        station: "Farseer Inc",
        purpose: "FSD",
        kind: "engineer",
        status: "todo",
        actions: [
          act({
            id: "u1",
            kind: "unlock_engineer",
            label: "Unlock Felicity Farseer",
            engineer: "Felicity Farseer",
          }),
          act({
            id: "e1",
            kind: "engineer",
            label: "Roll FSD Increased Range to G5",
            slot: "FrameShiftDrive",
            blueprint: "FSD_LongRange",
            grade: 5,
            needs_by_grade: FSD_BY_GRADE,
          }),
        ],
      },
      {
        system: "Arque",
        station: "Abel Laboratory",
        purpose: "Thrusters",
        kind: "engineer",
        status: "todo",
        actions: [
          act({
            id: "e2",
            kind: "engineer",
            label: "Roll thrusters Dirty to G5",
            slot: "MainEngines",
            blueprint: "Engine_Dirty",
            grade: 5,
          }),
        ],
      },
    ],
    created_at: iso(-60),
    updated_at: iso(-60),
    ...o,
  }) as Plan;

type Journal = JournalState & { events: JournalEvent[] };
const mats = (list: [string, string, number][]) =>
  list.map(([symbol, name, count]) => ({ symbol, name, count }));

const journal = (events: JournalEvent[], o: Partial<Journal> = {}): Journal => ({
  commander: null,
  credits: null,
  location: {
    system: null,
    station: null,
    station_type: null,
    docked: false,
    dist_from_star_ls: null,
  },
  ship: {
    type: "krait_mkii",
    id: KRAIT,
    name: null,
    ident: null,
    max_jump_range: null,
    cargo_capacity: null,
    fuel_capacity: null,
  },
  cargo: [],
  materials: { raw: [], manufactured: [], encoded: [] },
  missions: [],
  engineers: [],
  stored_modules: null,
  as_of: null,
  events,
  ...o,
});

const docked = (system: string, station: string, marketId = 1) => ({
  location: { system, station, station_type: null, docked: true, dist_from_star_ls: null },
});
const dock = (s: number, system: string, station: string, marketId = 1) =>
  ev(s, "Docked", { StarSystem: system, StationName: station, MarketID: marketId });

const loadout = (s: number, ship: string, id: number, modules: Record<string, unknown>[] = []) =>
  ev(s, "Loadout", { Ship: ship, ShipID: id, Modules: modules });

const fsd = (level: number, quality: number) => ({
  Slot: "FrameShiftDrive",
  Item: "int_hyperdrive_size5_class5",
  Engineering: { BlueprintName: "FSD_LongRange", Level: level, Quality: quality },
});

const craft = (s: number, level: number, quality: number, extra: Record<string, unknown> = {}) =>
  ev(s, "EngineerCraft", {
    Slot: "FrameShiftDrive",
    Module: "int_hyperdrive_size5_class5",
    Engineer: "Felicity Farseer",
    BlueprintName: "FSD_LongRange",
    Level: level,
    Quality: quality,
    Ingredients: [],
    ...extra,
  });

const FARSEER = {
  engineers: [
    { name: "Felicity Farseer", id: 300100, progress: "Unlocked", rank: 5, rank_progress: 0 },
  ],
};

/** At Farseer with the FSD at G3, full: the inventory short of Datamined Wake. */
const atFarseer = (extra: JournalEvent[] = []) =>
  journal(
    [loadout(1, "krait_mkii", KRAIT, [fsd(3, 1)]), dock(10, "Deciat", "Farseer Inc"), ...extra],
    {
      ...docked("Deciat", "Farseer Inc"),
      ...FARSEER,
      materials: {
        raw: mats([
          ["arsenic", "Arsenic", 3],
          ["manganese", "Manganese", 9],
        ]),
        manufactured: mats([
          ["chemicaldistillery", "Chemical Distillery", 9],
          ["chemicalmanipulators", "Chemical Manipulators", 2],
        ]),
        encoded: mats([["hyperspacetrajectories", "Eccentric Hyperspace Trajectories", 12]]),
      },
    },
  );

const panelOf = (plan: Plan, j: Journal, o: Partial<Parameters<typeof buildPanel>[0]> = {}) => {
  const choice = chooseBuild({ note: plan, plans: [], journal: j })!;
  return buildPanel({ choice, journal: j, settings: DEFAULT_SETTINGS.hud.build, ...o });
};

describe("the build panel", () => {
  it("shows an upgrade at an engineer, docked there before the trade stop", () => {
    const p = panelOf(upgrade(), atFarseer());
    expect(p).toMatchObject({
      mode: "build",
      title: "UPGRADE",
      subtitle: "Krait MkII · stop 2/3",
      right: "1/4 actions",
    });
    expect(p.rows).toEqual([
      { text: "● Deciat · Farseer Inc", right: "engineer · docked" },
      { text: "  ✓ Unlock Felicity Farseer", tone: "dim" },
      {
        text: "  Roll FSD Increased Range to G5",
        right: "G3 100% → G5 · ~5 rolls",
        detail: "short 1 Datamined Wake Exceptions (have 0/1) · trade at stop 1",
      },
      { text: "▸ Arque · Abel Laboratory", right: "roll 1", tone: "dim" },
    ]);
    expect(p.footer).toEqual(["1 open before · 1 after", "Target: FSD G5 · thrusters Dirty G5"]);
  });

  it("shows the grade and quality reached by a partial roll, and the rolls left", () => {
    const p = panelOf(upgrade(), atFarseer([craft(20, 3, 0.64)]));
    expect(p.rows[2]!.right).toBe("G3 64% → G5 · ~7 rolls");
  });

  it("counts a module with another blueprint from G1", () => {
    const j = journal([
      loadout(1, "krait_mkii", KRAIT, [
        { ...fsd(5, 1), Engineering: { BlueprintName: "FSD_FastBoot", Level: 5, Quality: 1 } },
      ]),
    ]);
    const plan = upgrade();
    const e = judgeBuild(plan, j).actions.find((x) => x.action.id === "e1")!;
    expect([...rollsLeft(e.action, e.fitted)]).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 1],
    ]);
    // 1 roll of G5's materials, 4 of G4's and 3 of G3's (no G1 or G2 given).
    expect(materialsLeft(e.action, e.fitted).find((m) => m.name === "Manganese")?.count).toBe(4);
  });

  it("uses the plan's rolls per grade", () => {
    const a = upgrade().stops[1]!.actions![1]!;
    const fitted = {
      item: null,
      blueprint: "FSD_LongRange",
      level: 3,
      quality: 0.5,
      experimental: null,
    };
    expect([...rollsLeft(a, fitted, [1, 1, 4, 2, 9])]).toEqual([
      [3, 2],
      [4, 2],
      [5, 1],
    ]);
    // At the target grade already: nothing left.
    expect(rollsLeft({ ...a, grade: 3 }, fitted).size).toBe(0);
  });

  it("marks the engineer action done at the grade, at any quality, and stays done", () => {
    const j = atFarseer([craft(20, 4, 1), craft(30, 5, 0.1)]);
    const e1 = judgeBuild(upgrade(), j).actions.find((x) => x.action.id === "e1")!;
    expect(e1.done).toBe(true);
    expect(e1.write).toMatchObject({
      status: "done",
      done_by: [{ at: iso(30), event: "EngineerCraft", n: 0, role: "rolled" }],
    });
    // Farseer is done: the panel moves to the next stop to do, the trade.
    const p = panelOf(upgrade(), j);
    expect(p.subtitle).toBe("Krait MkII · stop 1/3");
  });

  it("does not count a craft on another ship", () => {
    const j = atFarseer([loadout(15, "python_nx", PYTHON), craft(20, 5, 1)]);
    expect(judgeBuild(upgrade(), j).actions.find((x) => x.action.id === "e1")!.done).toBe(false);
  });

  it("folds done actions past doneShown, and keeps a not-fitted one", () => {
    const stop = {
      system: "Shinrarta Dezhra",
      station: "Jameson Memorial",
      purpose: "Outfit",
      kind: "shop" as const,
      status: "todo" as const,
      actions: [1, 2, 3, 4].map((n) =>
        act({
          id: `b${n}`,
          kind: "buy_module",
          label: `Buy booster ${n}`,
          module: "hpt_shieldbooster_size0_class5",
          status: "done",
          done_by: [],
        }),
      ),
    };
    stop.actions.push(
      act({
        id: "s1",
        kind: "sell_module",
        label: "Sell AFM Unit 2A",
        module: "int_repairer_size2_class1",
      }),
    );
    const plan = upgrade({ build: { target: "ship", scope: "full", ship_id: KRAIT } }, [stop]);
    const j = journal(
      [dock(1, "Shinrarta Dezhra", "Jameson Memorial")],
      docked("Shinrarta Dezhra", "Jameson Memorial"),
    );
    const p = panelOf(plan, j);
    expect(p.title).toBe("BUILD");
    expect(p.rows.slice(1)).toEqual([
      { text: "  ✓ 4 done", tone: "dim" },
      { text: "  Sell AFM Unit 2A" },
    ]);
    expect(p.subtitle).toBe("Krait MkII");
  });

  it("shows the price, not sold here from this visit's Outfitting.json, and the credits", () => {
    const stop = {
      system: "Shinrarta Dezhra",
      station: "Jameson Memorial",
      purpose: "Outfit",
      kind: "shop" as const,
      status: "todo" as const,
      actions: [
        act({
          id: "b1",
          kind: "buy_module",
          label: "Buy Shield Booster 0A",
          module: "hpt_shieldbooster_size0_class5",
          needs: { credits: 246_578 },
        }),
        act({
          id: "b2",
          kind: "buy_module",
          label: "Buy Enhanced Performance Thrusters 5A",
          module: "int_engine_size5_class5_fast",
          needs: { credits: 5_100_000 },
        }),
        act({
          id: "r1",
          kind: "retrieve_module",
          label: "Retrieve stored Shield Booster (Heavy Duty G5)",
          module: "hpt_shieldbooster_size0_class5",
          blueprint: "ShieldBooster_HeavyDuty",
          grade: 5,
        }),
        act({
          id: "f1",
          kind: "fetch_module",
          label: "Transfer Power Plant 6A",
          module: "int_powerplant_size6_class5",
        }),
      ],
    };
    const plan = upgrade({ build: { target: "ship", scope: "full", ship_id: KRAIT } }, [stop]);
    const stored = (symbol: string, market: number | null, extra = {}) => ({
      symbol,
      name: symbol,
      storage_slot: 1,
      system: "X",
      market_id: market,
      in_transit: false,
      transfer_cost: 100_000,
      transfer_time: 1500,
      buy_price: null,
      hot: false,
      blueprint: null,
      level: null,
      quality: null,
      ...extra,
    });
    const j = journal([dock(10, "Shinrarta Dezhra", "Jameson Memorial", 128666762)], {
      ...docked("Shinrarta Dezhra", "Jameson Memorial"),
      stored_modules: [
        stored("hpt_shieldbooster_size0_class5", 128666762),
        stored("int_powerplant_size6_class5", 99),
      ],
    });
    const outfitting = parseOutfitting(
      JSON.stringify({
        timestamp: iso(20),
        event: "Outfitting",
        MarketID: 128666762,
        Items: [{ id: 1, Name: "hpt_shieldbooster_size0_class5", BuyPrice: 246578 }],
      }),
    );
    const p = panelOf(plan, j, { outfitting, balance: 3_000_000 });
    expect(p.rows.slice(1)).toEqual([
      { text: "  Buy Shield Booster 0A", right: "247k · ready" },
      {
        text: "  Buy Enhanced Performance Thrusters 5A",
        right: "5.1M",
        detail: "not sold here",
        tone: "warn",
      },
      { text: "  Retrieve stored Shield Booster (Heavy Duty G5)", right: "here" },
      { text: "  Transfer Power Plant 6A", right: "100k · ~25 min" },
    ]);
    expect(p.footer).toEqual([{ text: "5.3M to spend · 3.0M held", tone: "warn" }]);
    // An older Outfitting.json, from before this docking, says nothing.
    const old = { ...outfitting!, at: T0 };
    expect(panelOf(plan, j, { outfitting: old }).rows[2]).toEqual({
      text: "  Buy Enhanced Performance Thrusters 5A",
      right: "5.1M · ready",
    });
  });

  it("shows a collect stop's count held and its notes, and finishes it by the inventory", () => {
    const stop = {
      system: "HIP 36601",
      body: "C 3 b",
      purpose: "Collect",
      kind: "gather" as const,
      status: "todo" as const,
      notes: "mine with SRV",
      actions: [
        act({
          id: "c1",
          kind: "collect_material",
          label: "Collect 4 Selenium",
          material: "Selenium",
          count: 4,
        }),
      ],
    };
    const plan = upgrade({}, [stop]);
    const land = ev(5, "Touchdown", {
      StarSystem: "HIP 36601",
      Body: "HIP 36601 C 3 b",
      OnPlanet: true,
    });
    const j = journal([land], {
      materials: { raw: mats([["selenium", "Selenium", 1]]), manufactured: [], encoded: [] },
    });
    const p = panelOf(plan, j);
    expect(p.rows).toEqual([
      { text: "● HIP 36601 · C 3 b", right: "collect · landed" },
      { text: "  Collect 4 Selenium", right: "1/4", detail: "mine with SRV" },
    ]);
    const full = {
      ...j,
      materials: { raw: mats([["selenium", "Selenium", 4]]), manufactured: [], encoded: [] },
    };
    expect(judgeBuild(plan, full).actions[0]).toMatchObject({
      done: true,
      write: { status: "done", key: "krait|c1" },
    });
    expect(landedAt([land, ev(6, "Liftoff")])).toBeNull();
  });

  it("puts an experimental after its blueprint at the same stop", () => {
    const plan = upgrade();
    plan.stops[1]!.actions!.push(
      act({
        id: "x1",
        kind: "experimental",
        label: "Apply Mass Manager to FSD",
        slot: "FrameShiftDrive",
        experimental: "special_fsd_heavy",
      }),
    );
    expect(panelOf(plan, atFarseer()).rows[3]).toEqual({
      text: "  Apply Mass Manager to FSD",
      right: "after FSD G5",
    });
  });

  it("says Build complete once the last action is done this docking", () => {
    const plan = upgrade({}, [upgrade().stops[1]!]);
    plan.stops[0]!.actions = [plan.stops[0]!.actions![1]!];
    const j = atFarseer([craft(20, 5, 0.3)]);
    const p = panelOf(plan, j);
    expect(p).toMatchObject({ right: "Build complete", tone: "good", rows: [] });
    expect(buildNow({ note: plan, plans: [], journal: j }).active).toBe(true);
    // Undocked: nothing left to show.
    const away = {
      ...j,
      events: [...j.events, ev(40, "Undocked")],
      location: { ...j.location, docked: false },
    };
    expect(buildNow({ note: plan, plans: [], journal: away }).active).toBe(false);
  });

  it("names the ship type as the game does", () => {
    expect(shipName("python_nx")).toBe("Python MkII");
    expect(shipName("new_ship")).toBe("new_ship");
    expect(shipName(null)).toBeNull();
    expect(parseOutfitting("{")).toBeNull();
    expect(parseOutfitting("{}")).toBeNull();
  });
});

describe("judging ship actions", () => {
  const shop = (actions: Action[], o: Partial<Plan> = {}) =>
    upgrade(
      { build: { target: "ship", scope: "full", ship_id: KRAIT, started_at: iso(0) }, ...o },
      [{ system: "S", station: "Port", purpose: "Outfit", kind: "shop", status: "todo", actions }],
    );
  const done = (plan: Plan, events: JournalEvent[], o: Partial<Journal> = {}) =>
    judgeBuild(plan, journal(events, o)).actions.map((x) => x.done);
  const BOOSTER = "$hpt_shieldbooster_size0_class5_name;";
  const buy = (s: number, extra: Record<string, unknown> = {}) =>
    ev(s, "ModuleBuy", {
      Slot: "TinyHardpoint1",
      BuyItem: BOOSTER,
      BuyPrice: 1,
      Ship: "krait_mkii",
      ShipID: KRAIT,
      ...extra,
    });
  const buys = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      act({
        id: `b${i}`,
        kind: "buy_module",
        label: "Buy booster",
        module: "hpt_shieldbooster_size0_class5",
      }),
    );

  it("needs eight buys for eight identical buy actions", () => {
    const plan = shop(buys(8));
    expect(
      done(
        plan,
        [1, 2, 3].map((s) => buy(s)),
      ),
    ).toEqual([true, true, true, false, false, false, false, false]);
  });

  it("names two events in the same second apart", () => {
    const j = judgeBuild(shop(buys(2)), journal([buy(1), buy(1)]));
    expect(j.actions.map((x) => x.write?.done_by?.[0]?.n)).toEqual([0, 1]);
  });

  it("counts only events after the plan started", () => {
    expect(done(shop(buys(1)), [buy(-5)])).toEqual([false]);
  });

  it("finishes a buy and a sell with one ModuleBuy that sold the old module", () => {
    const plan = shop([
      ...buys(1),
      act({
        id: "s",
        kind: "sell_module",
        label: "Sell",
        module: "hpt_heatsinklauncher_turret_tiny",
      }),
      act({
        id: "st",
        kind: "store_module",
        label: "Store",
        module: "hpt_heatsinklauncher_turret_tiny",
      }),
    ]);
    expect(
      done(plan, [buy(1, { SellItem: "$hpt_heatsinklauncher_turret_tiny_name;", SellPrice: 1 })]),
    ).toEqual([true, true, false]);
    expect(done(plan, [buy(1, { StoredItem: "$hpt_heatsinklauncher_turret_tiny_name;" })])).toEqual(
      [true, false, true],
    );
  });

  it("matches a buy's slot, and a buy into storage only with no slot", () => {
    const plan = shop([
      act({
        id: "b",
        kind: "buy_module",
        label: "Buy",
        module: "hpt_shieldbooster_size0_class5",
        slot: "TinyHardpoint2",
      }),
    ]);
    expect(done(plan, [buy(1)])).toEqual([false]);
    expect(done(plan, [buy(1, { Slot: "TinyHardpoint2" })])).toEqual([true]);
    const store = ev(1, "ModuleBuyAndStore", {
      BuyItem: BOOSTER,
      Ship: "krait_mkii",
      ShipID: KRAIT,
    });
    expect(done(plan, [store])).toEqual([false]);
    expect(done(shop(buys(1)), [store])).toEqual([true]);
  });

  it("fills two store actions from one MassModuleStore", () => {
    const store = () =>
      act({
        id: `s${Math.random()}`,
        kind: "store_module",
        label: "Store",
        module: "int_cargorack_size2_class1",
      });
    const e = ev(1, "MassModuleStore", {
      Ship: "krait_mkii",
      ShipID: KRAIT,
      Items: [
        { Slot: "Slot01", Name: "$int_cargorack_size2_class1_name;" },
        { Slot: "Slot02", Name: "$int_cargorack_size2_class1_name;" },
      ],
    });
    expect(done(shop([store(), store(), store()]), [e])).toEqual([true, true, false]);
  });

  it("judges a retrieve of an engineered module by its blueprint and grade", () => {
    const plan = shop([
      act({
        id: "r",
        kind: "retrieve_module",
        label: "Retrieve",
        module: "hpt_shieldbooster_size0_class5",
        blueprint: "ShieldBooster_HeavyDuty",
        grade: 5,
      }),
      act({ id: "s", kind: "store_module", label: "Store", module: "int_cargorack_size2_class1" }),
    ]);
    const r = (level: number) =>
      ev(1, "ModuleRetrieve", {
        Slot: "TinyHardpoint1",
        RetrievedItem: BOOSTER,
        Ship: "krait_mkii",
        ShipID: KRAIT,
        EngineerModifications: "ShieldBooster_HeavyDuty",
        Level: level,
        Quality: 1,
        SwapOutItem: "$int_cargorack_size2_class1_name;",
      });
    expect(done(plan, [r(4)])).toEqual([false, true]);
    expect(done(plan, [r(5)])).toEqual([true, true]);
  });

  it("judges a fetch, a sale from storage, a move both ways, and a tech unlock", () => {
    const plan = shop([
      act({ id: "f", kind: "fetch_module", label: "Fetch", storage_slot: 29 }),
      act({ id: "s", kind: "sell_module", label: "Sell", module: "int_hyperdrive_size4_class5" }),
      act({
        id: "m1",
        kind: "move_module",
        label: "Move",
        module: "int_shieldcellbank_size4_class5",
        slot: "Slot05_Size4",
      }),
      act({
        id: "m2",
        kind: "move_module",
        label: "Move",
        module: "int_cargorack_size4_class1",
        slot: "Slot03_Size4",
      }),
      act({
        id: "u",
        kind: "unlock_tech",
        label: "Unlock",
        item: "Int_GuardianFSDBooster_Size5",
        broker: "guardian",
      }),
      act({ id: "y", kind: "synthesis", label: "Synthesise", recipe: "FSD Premium" }),
    ]);
    expect(
      done(plan, [
        ev(1, "FetchRemoteModule", {
          StorageSlot: 29,
          StoredItem: "$int_hyperdrive_size4_class5_name;",
          ShipID: 1,
        }),
        ev(2, "ModuleSellRemote", {
          StorageSlot: 3,
          SellItem: "$int_hyperdrive_size4_class5_name;",
          SellPrice: 1,
        }),
        ev(3, "ModuleSwap", {
          FromSlot: "Slot03_Size4",
          ToSlot: "Slot05_Size4",
          FromItem: "$int_shieldcellbank_size4_class5_name;",
          ToItem: "$int_cargorack_size4_class1_name;",
          Ship: "krait_mkii",
          ShipID: KRAIT,
        }),
        ev(4, "TechnologyBroker", {
          BrokerType: "guardian",
          ItemsUnlocked: [{ Name: "Int_GuardianFSDBooster_Size5" }],
        }),
        ev(5, "Synthesis", { Name: "FSD Premium", Materials: [] }),
      ]),
    ).toEqual([true, true, true, true, true, true]);
  });

  it("shares a trade's materials across two trade actions", () => {
    const trade = (id: string) =>
      act({
        id,
        kind: "trade_material",
        label: "Trade",
        paid: { material: "Wake", count: 18 },
        received: { material: "Datamined Wake Exceptions", count: 3 },
      });
    const plan = shop([trade("a"), trade("b")]);
    const got = (s: number, q: number) =>
      ev(s, "MaterialTrade", {
        TraderType: "encoded",
        Paid: { Material: "hyperspacetrajectories", Quantity: q * 6 },
        Received: {
          Material: "dataminedwake",
          Material_Localised: "Datamined Wake Exceptions",
          Quantity: q,
        },
      });
    let j = judgeBuild(plan, journal([got(1, 2), got(2, 2)]));
    expect(j.actions.map((x) => [x.done, x.taken])).toEqual([
      [true, 3],
      [false, 1],
    ]);
    expect(j.actions[0]!.write!.done_by).toEqual([
      { at: iso(1), event: "MaterialTrade", n: 0, role: "received", amount: 2 },
      { at: iso(2), event: "MaterialTrade", n: 0, role: "received", amount: 1 },
    ]);
    // Once written, the claims hold: the share-out is the same on the next poll.
    plan.stops[0]!.actions![0] = {
      ...plan.stops[0]!.actions![0]!,
      status: "done",
      done_by: j.actions[0]!.write!.done_by,
    };
    j = judgeBuild(plan, journal([got(1, 2), got(2, 2), got(3, 2)]));
    expect(j.actions.map((x) => [x.done, x.taken])).toEqual([
      [true, 3],
      [true, 3],
    ]);
  });

  it("gives an action marked done by hand the event before it was marked", () => {
    const plan = shop(buys(2), { updated_at: iso(5) });
    plan.stops[0]!.actions![0]!.status = "done";
    const j = judgeBuild(plan, journal([buy(1)]));
    expect(j.actions[0]!.write).toEqual({
      done_by: [{ at: iso(1), event: "ModuleBuy", n: 0, role: "bought" }],
      key: "krait|b0|adopt",
    });
    // So the next identical action stays open.
    expect(j.actions[1]!.done).toBe(false);
    // With no such event, it claims nothing.
    expect(
      judgeBuild(plan, journal([buy(9)])).actions.map((x) => [x.done, x.write?.done_by]),
    ).toEqual([
      [true, []],
      [true, [{ at: iso(9), event: "ModuleBuy", n: 0, role: "bought" }]],
    ]);
  });

  it("binds a plan with no ship_id by type, and writes the ShipID", () => {
    const plan = shop(buys(1), {
      build: { target: "ship", scope: "full", ship: "krait_mkii", started_at: iso(0) },
    });
    const j = judgeBuild(plan, journal([buy(1, { Ship: "python_nx", ShipID: PYTHON }), buy(2)]));
    expect(j.boundId).toBe(KRAIT);
    expect(j.actions[0]!.write!.done_by![0]!.at).toBe(iso(2));
  });

  it("does not bind a plan with a buy_ship by type: the new hull is its ship", () => {
    const plan = shop(
      [
        act({ id: "h", kind: "buy_ship", label: "Buy Krait", ship: "krait_mkii" }),
        act({ id: "w", kind: "swap_ship", label: "Take out the Krait" }),
        ...buys(1),
      ],
      { build: { target: "ship", scope: "full", ship: "krait_mkii", started_at: iso(0) } },
    );
    // A buy on the Krait already owned is not for this plan.
    let j = judgeBuild(plan, journal([buy(1)]));
    expect(j.actions.map((x) => x.done)).toEqual([false, false, false]);
    j = judgeBuild(
      plan,
      journal([
        buy(1),
        ev(2, "ShipyardBuy", {
          ShipType: "krait_mkii",
          ShipPrice: 1,
          StoreOldShip: "Krait_MkII",
          StoreShipID: KRAIT,
        }),
        ev(3, "ShipyardNew", { ShipType: "krait_mkii", NewShipID: 77 }),
        buy(4, { ShipID: 77 }),
      ]),
    );
    expect(j.actions.map((x) => x.done)).toEqual([true, true, true]);
    expect(j.boundId).toBe(77);
  });

  it("judges a transfer and a swap to a ship_id", () => {
    const plan = shop([
      act({ id: "t", kind: "transfer_ship", label: "Transfer", ship_id: PYTHON }),
      act({ id: "s", kind: "swap_ship", label: "Swap", ship_id: PYTHON }),
    ]);
    expect(
      done(plan, [
        ev(1, "ShipyardTransfer", { ShipType: "Python_NX", ShipID: PYTHON, TransferPrice: 1 }),
        ev(2, "ShipyardSwap", { ShipType: "python_nx", ShipID: PYTHON }),
      ]),
    ).toEqual([true, true]);
  });

  it("applies an experimental, and marks a done module no longer fitted", () => {
    const plan = upgrade();
    plan.stops[1]!.actions!.push(
      act({
        id: "x",
        kind: "experimental",
        label: "Apply Mass Manager",
        slot: "FrameShiftDrive",
        experimental: "special_fsd_heavy",
      }),
    );
    const j = atFarseer([
      craft(20, 5, 0.2),
      craft(21, 5, 0.2, { ApplyExperimentalEffect: "special_fsd_heavy" }),
    ]);
    const judged = judgeBuild(plan, j);
    expect(judged.actions.filter((x) => x.stop === 1).map((x) => x.done)).toEqual([
      true,
      true,
      true,
    ]);
    // A Loadout after it without the blueprint: done, but not fitted now.
    const later = { ...j, events: [...j.events, loadout(30, "krait_mkii", KRAIT, [fsd(2, 1)])] };
    const e = judgeBuild(plan, later).actions.find((x) => x.action.id === "e1")!;
    expect(e.notFitted).toBe(true);
    // Shown while the stop is current: it has another action to do. (A plan read again is a new
    // object: the judgement is kept for the same one.)
    const more = structuredClone(plan);
    more.stops[1]!.actions!.push(
      act({ id: "s", kind: "synthesis", label: "Synthesise FSD Premium", recipe: "FSD Premium" }),
    );
    const p = panelOf(more, later);
    expect(p.rows).toContainEqual({
      text: "  ✓ Roll FSD Increased Range to G5",
      right: "not fitted now",
      tone: "warn",
    });
  });

  it("is a build plan only with stop actions for a ship", () => {
    expect(isBuildPlan(upgrade())).toBe(true);
    expect(isBuildPlan(upgrade({}, [{ system: "S", purpose: "x", status: "todo" }]))).toBe(false);
    expect(isBuildPlan(upgrade({ build: { target: "suit_loadout", scope: "full" } }))).toBe(false);
    expect(isBuildPlan(null)).toBe(false);
  });
});

describe("the build mode", () => {
  const on = () => true;
  const now = (plan: Plan, j: Journal) => buildNow({ note: null, plans: [plan], journal: j });

  it("turns on for an event that matches an open action, not for one the plan does not ask for", () => {
    const j = atFarseer([craft(20, 4, 0.5), ev(30, "Synthesis", { Name: "Ammo Basic" })]);
    const b = now(upgrade(), j);
    expect(journalMode(j.events, false, false, on, false, undefined, b)).toEqual({
      mode: "build",
      at: T0 + 20_000,
    });
    // Without the plan, the same events (and the docking) change nothing.
    expect(journalMode(j.events, false, false, on)).toBeNull();
  });

  it("turns on for docking at a build stop, and a scan after takes over", () => {
    const j = journal(
      [dock(1, "Deciat", "Farseer Inc"), ev(5, "FSSDiscoveryScan")],
      docked("Deciat", "Farseer Inc"),
    );
    const b = now(upgrade(), j);
    expect(journalMode(j.events.slice(0, 1), false, false, on, false, undefined, b)?.mode).toBe(
      "build",
    );
    expect(journalMode(j.events, false, false, on, false, undefined, b)?.mode).toBe("exploration");
    // Docking at the next build stop brings it back; a jump never ends it.
    const back = [
      ...j.events,
      ev(9, "FSDJump", { StarSystem: "Arque" }),
      dock(10, "Arque", "Abel Laboratory"),
    ];
    expect(journalMode(back, false, false, on, false, undefined, b)?.mode).toBe("build");
    expect(
      journalMode(
        [
          ...back,
          ev(11, "FSDJump"),
          ev(12, "FSDJump"),
          ev(13, "FSDJump"),
          ev(14, "FSDJump"),
          ev(15, "FSDJump"),
          ev(16, "FSDJump"),
        ],
        false,
        false,
        on,
        false,
        undefined,
        b,
      )?.mode,
    ).toBe("build");
  });

  it("turns on for landing at a gather stop", () => {
    const stop = {
      system: "HIP 36601",
      body: "C 3 b",
      purpose: "Collect",
      kind: "gather" as const,
      status: "todo" as const,
      actions: [
        act({
          id: "c",
          kind: "collect_material",
          label: "Collect",
          material: "Selenium",
          count: 4,
        }),
      ],
    };
    const b = now(upgrade({}, [stop]), journal([]));
    const land = ev(1, "Touchdown", {
      StarSystem: "HIP 36601",
      Body: "HIP 36601 C 3 b",
      OnPlanet: true,
    });
    expect(atBuildStop(land, b.stops)).toBe(true);
    expect(
      atBuildStop(
        ev(1, "Disembark", { StarSystem: "HIP 36601", Body: "HIP 36601 C 3 b", OnPlanet: true }),
        b.stops,
      ),
    ).toBe(true);
    expect(
      atBuildStop(ev(1, "Touchdown", { StarSystem: "HIP 36601", Body: "HIP 36601 C 4" }), b.stops),
    ).toBe(false);
    expect(journalMode([land], false, false, on, false, undefined, b)?.mode).toBe("build");
  });

  it("lets massacre win while a stack is open, and the build come back after", () => {
    const j = atFarseer([
      ev(15, "MissionAccepted", { Name: "Mission_Massacre", KillCount: 10, MissionID: 1 }),
      craft(20, 4, 0.5),
    ]);
    const b = now(upgrade(), j);
    expect(journalMode(j.events, true, false, on, false, undefined, b)?.mode).toBe("massacre");
    expect(journalMode(j.events, false, false, on, false, undefined, b)?.mode).toBe("build");
  });

  it("turns on for a swap to a ship with an open build plan", () => {
    const b = { ...now(upgrade(), journal([])), active: true };
    expect(
      journalMode(
        [ev(1, "ShipyardSwap", { ShipType: "krait_mkii", ShipID: KRAIT })],
        false,
        false,
        on,
        false,
        undefined,
        b,
      )?.mode,
    ).toBe("build");
    expect(
      journalMode(
        [ev(1, "ShipyardSwap", { ShipType: "python_nx", ShipID: PYTHON })],
        false,
        false,
        on,
        false,
        undefined,
        b,
      ),
    ).toBeNull();
    expect(noteMode("engineering")).toBe("build");
  });

  const hudInput = (o: Partial<HudInput> = {}): HudInput => ({
    journal: atFarseer(),
    status: null,
    nav: null,
    activity: null,
    plan: null,
    hotkey: null,
    samples: new Map(),
    known: null,
    settings: DEFAULT_SETTINGS.hud,
    now: T0 + 60_000,
    ...o,
  });

  it("follows an engineering note with a build plan, and not with hud.modes.build off", () => {
    const activity = {
      kind: "engineering" as const,
      summary: "Krait",
      plan_id: "krait",
      updated_at: iso(50),
    };
    expect(currentMode(hudInput({ activity, plan: upgrade() }))).toBe("build");
    const off = { ...DEFAULT_SETTINGS.hud, modes: { ...DEFAULT_SETTINGS.hud.modes, build: false } };
    expect(currentMode(hudInput({ activity, plan: upgrade(), settings: off }))).not.toBe("build");
    // An engineering note whose plan has no stop actions shows the route rows only.
    const plain = upgrade({}, [{ system: "Deciat", purpose: "x", status: "todo" }]);
    expect(currentMode(hudInput({ activity, plan: plain }))).toBeNull();
  });

  it("shows the plan docked at over the note's, with the route keys and the game note following it", () => {
    const note = upgrade(
      { id: "other", name: "Other", build: { target: "ship", scope: "full", ship_id: KRAIT } },
      [
        {
          system: "Far",
          station: "Away",
          purpose: "x",
          kind: "shop",
          status: "todo",
          actions: [act({ id: "b", kind: "buy_module", label: "Buy", module: "x" })],
        },
      ],
    );
    const activity = {
      kind: "engineering" as const,
      summary: "Other",
      plan_id: "other",
      updated_at: iso(0),
    };
    const v = buildHud(hudInput({ activity, plan: note, buildPlans: [upgrade()] }), null);
    expect(v.panel?.subtitle).toBe("Krait MkII · stop 2/3");
    expect(v.follow).toEqual({ planId: "krait", stop: 1 });
    expect(v.route).toBeNull();
    expect(gameContext(null, null, v)).toContain(
      "Showing build plan krait (docked at its stop); the activity note names other.",
    );
    // The forward key marks the stop shown, not the plan's first stop to do.
    expect(routeStep(upgrade(), 1, v.follow!.stop)).toEqual({
      update: { index: 1, status: "done" },
    });
    expect(routeStep(upgrade(), 1)).toEqual({ update: { index: 0, status: "done" } });
  });

  it("leaves another ship's plan out unless it is the note's or docked at its stop", () => {
    const python = upgrade(
      { id: "py", build: { target: "ship", scope: "full", ship_id: PYTHON } },
      [
        {
          system: "Far",
          station: "Away",
          purpose: "x",
          kind: "shop",
          status: "todo",
          actions: [act({ id: "b", kind: "buy_module", label: "Buy", module: "x" })],
        },
      ],
    );
    expect(chooseBuild({ note: null, plans: [python], journal: atFarseer() })).toBeNull();
    expect(chooseBuild({ note: python, plans: [], journal: atFarseer() })?.plan.id).toBe("py");
  });
});
