import { describe, expect, it } from "vitest";
import type { ActionPatch, JournalEvent, JournalState, Plan } from "ed-mcp/journal";
import { ActionFinisher } from "../src/core/hud/actionStops.js";
import { buildPanel, chooseBuild } from "../src/core/hud/build.js";
import { isBuildPlan, judgeBuild, type Action } from "../src/core/hud/buildJudge.js";
import { resourceCount, sameMod, sameWeapon, suitOf } from "../src/core/hud/foot.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

// On foot: suit loadout plans, judged from the suit and weapon events, the loadouts and the ship
// locker. See "On foot" in docs/superpowers/specs/2026-11-22-build-panel.md.

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const ev = (s: number, event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: iso(s),
  event,
  ...extra,
});

type Journal = JournalState & { events: JournalEvent[] };
type Locker = NonNullable<JournalState["locker"]>;
const box = (items: [string, number][]): Locker => ({
  items: items.map(([name, count]) => ({ name, name_localised: null, count })),
  components: [],
  consumables: [],
  data: [],
  as_of: iso(0),
});

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
    id: 12,
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
  suits: [],
  weapons: [],
  suit_loadouts: [],
  locker: null,
  backpack: null,
  as_of: null,
  events,
  ...o,
});

const act = (a: Partial<Action> & Pick<Action, "id" | "kind">): Action =>
  ({ status: "todo", label: a.id, ...a }) as Action;

let plans = 0;
/** A Dominator loadout: buy it, upgrade it, trade for a resource, modify it at an engineer. */
const loadout = (o: { stops?: Plan["stops"]; build?: Partial<NonNullable<Plan["build"]>> } = {}) =>
  ({
    id: `suit${++plans}`,
    name: "Dominator",
    items: [],
    build: { target: "suit_loadout", scope: "full", ...o.build },
    started_at: iso(0),
    created_at: iso(-60),
    updated_at: iso(-60),
    stops: o.stops ?? [
      {
        system: "Kuwemaki",
        station: "Mitchell Ring",
        purpose: "Pioneer Supplies",
        status: "todo",
        actions: [
          act({
            id: "buy",
            kind: "buy_suit",
            label: "Buy Dominator G3",
            suit: "Dominator",
            grade: 3,
            gear: "dom",
          }),
          act({
            id: "up",
            kind: "upgrade_suit",
            label: "Upgrade Dominator to G4",
            grade: 4,
            gear: "dom",
            needs: { credits: 100, materials: [{ name: "Health Monitor", count: 2 }] },
          }),
        ],
      },
      {
        system: "Kuwemaki",
        station: "Mitchell Ring",
        purpose: "Bartender",
        status: "todo",
        actions: [
          act({
            id: "hm",
            kind: "trade_resource",
            label: "Trade for 2 Health Monitor",
            received: { material: "Health Monitor", count: 2 },
          }),
        ],
      },
      {
        system: "Orishis",
        station: "The Jackrabbit",
        purpose: "Domino Green",
        status: "todo",
        actions: [
          act({
            id: "ammo",
            kind: "modify_suit",
            label: "Apply Extra Ammo Capacity",
            modification: "Extra Ammo Capacity",
            gear: "dom",
          }),
        ],
      },
    ],
  }) as Plan;

const buySuit = (s: number, grade = 3, id = 77) =>
  ev(s, "BuySuit", { Name: `TacticalSuit_Class${grade}`, Price: 1, SuitID: id, SuitMods: [] });
const docked = (s: number, system: string, station: string) =>
  ev(s, "Docked", { StarSystem: system, StationName: station, MarketID: 1 });

const done = (p: Plan, j: Journal) => judgeBuild(p, j).actions.map((x) => [x.action.id, x.done]);

describe("on-foot names", () => {
  it("knows a suit by its game name, journal type or journal name, with its grade", () => {
    expect(suitOf("Dominator")).toEqual({ type: "tacticalsuit", grade: null });
    expect(suitOf("Dominator G3")).toEqual({ type: "tacticalsuit", grade: 3 });
    expect(suitOf("TacticalSuit_Class2")).toEqual({ type: "tacticalsuit", grade: 2 });
    expect(suitOf("Maverick")?.type).toBe("utilitysuit");
    // The game's own name, and stray spaces.
    expect(suitOf("Dominator Suit")).toEqual({ type: "tacticalsuit", grade: null });
    expect(suitOf(" Dominator G3 ")).toEqual({ type: "tacticalsuit", grade: 3 });
    expect(suitOf("Flight Suit")?.type).toBe("flightsuit");
  });

  it("matches a modification by its game name or its symbol", () => {
    expect(sameMod("suit_increasedammoreserves", "Extra Ammo Capacity")).toBe(true);
    expect(sameMod("suit_increasedammoreserves", "suit_increasedammoreserves")).toBe(true);
    expect(sameMod("weapon_handling", "Faster Handling")).toBe(true);
    expect(sameMod("weapon_handling", "Greater Range")).toBe(false);
  });

  it("matches a weapon by its game name or its journal name", () => {
    expect(sameWeapon("wpn_m_assaultrifle_kinetic_fauto", "Karma AR-50", "Karma AR-50")).toBe(true);
    expect(
      sameWeapon("wpn_m_assaultrifle_kinetic_fauto", null, "Wpn_M_AssaultRifle_Kinetic_FAuto"),
    ).toBe(true);
    expect(sameWeapon("wpn_x", null, "Karma AR-50")).toBe(false);
  });

  it("counts a resource in the locker and backpack together", () => {
    const j = { locker: box([["healthmonitor", 2]]), backpack: box([["healthmonitor", 1]]) };
    expect(resourceCount(j, "Health Monitor")).toBe(3);
    expect(resourceCount(j, "healthmonitor")).toBe(3);
    expect(resourceCount({ locker: null, backpack: null }, "healthmonitor")).toBe(0);
    // Two names for one resource count it once.
    expect(resourceCount(j, "Health Monitor", "healthmonitor")).toBe(3);
  });
});

describe("judging a suit loadout plan", () => {
  it("is a build plan", () => {
    expect(isBuildPlan(loadout())).toBe(true);
  });

  it("finishes a buy by the suit bought, at least its grade, and gives the gear its ID", () => {
    const p = loadout();
    expect(done(p, journal([buySuit(5, 2)]))[0]).toEqual(["buy", false]);
    const j = judgeBuild(p, journal([buySuit(5, 3)]));
    expect(j.actions[0]!.done).toBe(true);
    expect(j.gearIds).toEqual([{ gear: "dom", suit_id: 77 }]);
  });

  it("waits on an upgrade of gear still to buy, then finishes it by the upgrade of that suit", () => {
    const p = loadout();
    const up = ev(9, "UpgradeSuit", { Name: "tacticalsuit_class3", SuitID: 77, Class: 4, Cost: 1 });
    // No ID yet: the upgrade cannot be told from another suit's.
    expect(done(p, journal([buySuit(5), up]))[1]).toEqual(["up", false]);
    p.stops[0]!.actions![1]!.suit_id = 77;
    p.stops[2]!.actions![0]!.suit_id = 77;
    p.updated_at = iso(-30);
    expect(done(p, journal([buySuit(5), up]))[1]).toEqual(["up", true]);
    // Another suit's upgrade is not this one's.
    const other = ev(9, "UpgradeSuit", { Name: "tacticalsuit_class3", SuitID: 78, Class: 4 });
    expect(done(p, journal([buySuit(5), other]))[1]).toEqual(["up", false]);
  });

  it("takes an upgrade the suit shows already as done, as the loadout is the record", () => {
    const p = loadout();
    p.stops[0]!.actions![1]!.suit_id = 77;
    const suits = [{ id: 77, type: "tacticalsuit", name: "Dominator", grade: 4, mods: [] }];
    expect(done(p, journal([], { suits }))[1]).toEqual(["up", true]);
  });

  it("finishes a modification once the suit shows it, and a trade by what was received", () => {
    const p = loadout();
    p.stops[2]!.actions![0]!.suit_id = 77;
    const trade = (s: number, n: number) =>
      ev(s, "TradeMicroResources", {
        Offered: [],
        Received: "healthmonitor",
        Received_Localised: "Health Monitor",
        Count: n,
      });
    const suits = [
      {
        id: 77,
        type: "tacticalsuit",
        name: "Dominator",
        grade: 3,
        mods: ["suit_increasedammoreserves"],
      },
    ];
    const r = judgeBuild(p, journal([trade(5, 1), trade(6, 1)], { suits }));
    expect(r.actions.map((x) => [x.action.id, x.done])).toEqual([
      ["buy", false],
      ["up", false],
      ["hm", true],
      ["ammo", true],
    ]);
    expect(r.actions[2]!.write?.done_by?.map((d) => d.amount)).toEqual([1, 1]);
  });

  it("finishes a resource bought, in either form of BuyMicroResources, and one collected", () => {
    const stops = [
      {
        system: "S",
        purpose: "x",
        status: "todo" as const,
        actions: [
          act({ id: "buy", kind: "buy_resource", resource: "Energy Cell", count: 3 }),
          act({ id: "get", kind: "collect_resource", resource: "Suit Schematic", count: 2 }),
        ],
      },
    ];
    const p = loadout({ stops });
    const old = ev(5, "BuyMicroResources", {
      Name: "energycell",
      Name_Localised: "Energy Cell",
      Count: 2,
    });
    const newer = ev(6, "BuyMicroResources", {
      Items: [{ Name: "energycell", Count: 1 }],
      TotalCount: 1,
    });
    const locker = box([["suitschematic", 2]]);
    expect(done(p, journal([old, newer], { locker }))).toEqual([
      ["buy", true],
      ["get", true],
    ]);
  });
});

const panel = (p: Plan, j: Journal) => {
  const choice = chooseBuild({ note: p, plans: [], journal: j })!;
  return buildPanel({ choice, journal: j, settings: DEFAULT_SETTINGS.hud.build });
};

describe("owned gear the plan does not name by ID", () => {
  const owned = (kind: "upgrade_suit" | "modify_suit", o: Partial<Action> = {}) =>
    loadout({
      stops: [
        {
          system: "S",
          station: "P",
          purpose: "x",
          status: "todo",
          actions: [
            act({ id: "a", kind, grade: 4, suit: "Dominator", modification: "Night Vision", ...o }),
          ],
        },
      ],
    });
  const suit = (id: number, type: string, grade: number, mods: string[] = []) => ({
    id,
    type,
    name: null,
    grade,
    mods,
  });

  it("is the one owned suit of its type", () => {
    const suits = [suit(1, "tacticalsuit", 4), suit(2, "utilitysuit", 1)] as never;
    expect(done(owned("upgrade_suit"), journal([], { suits }))).toEqual([["a", true]]);
    const mods = [suit(1, "tacticalsuit", 3, ["suit_nightvision"])] as never;
    expect(done(owned("modify_suit"), journal([], { suits: mods }))).toEqual([["a", true]]);
  });

  it("is the plan's loadout's suit, when there are two of its type", () => {
    const suits = [suit(1, "tacticalsuit", 2), suit(2, "tacticalsuit", 4)] as never;
    const p = owned("upgrade_suit");
    expect(done(p, journal([], { suits }))).toEqual([["a", false]]);
    p.build!.loadout_id = 9;
    p.id = `${p.id}-l`;
    const suit_loadouts = [
      { id: 9, name: "Combat", suit_id: 2, weapons: [], complete: true },
    ] as never;
    expect(done(p, journal([], { suits, suit_loadouts }))).toEqual([["a", true]]);
  });

  it("takes the one suit owned when the step names no type", () => {
    const suits = [suit(1, "utilitysuit", 4)] as never;
    expect(done(owned("upgrade_suit", { suit: undefined }), journal([], { suits }))).toEqual([
      ["a", true],
    ]);
  });

  it("treats gear whose buy was skipped as owned gear", () => {
    const p = loadout();
    p.stops[0]!.actions![0]!.status = "skipped";
    // The Dominator already owned: the upgrade of gear "dom" is judged against it.
    const suits = [suit(5, "tacticalsuit", 4)] as never;
    p.stops[0]!.actions![1]!.suit = "Dominator";
    expect(judgeBuild(p, journal([], { suits })).actions[1]!.done).toBe(true);
  });

  it("says a suit not owned needs buying, rather than asking which", () => {
    const j = journal([docked(1, "S", "P")], {
      location: {
        system: "S",
        station: "P",
        station_type: null,
        docked: true,
        dist_from_star_ls: null,
      },
    });
    expect(panel(owned("upgrade_suit", { label: "Up" }), j).rows).toContainEqual({
      text: "  Up",
      right: "not owned",
      detail: "buy it first (a buy step in the plan)",
      tone: "warn",
    });
  });

  it("asks which suit when it cannot tell", () => {
    const suits = [suit(1, "tacticalsuit", 2), suit(2, "tacticalsuit", 3)] as never;
    const j = journal([docked(1, "S", "P")], {
      location: {
        system: "S",
        station: "P",
        station_type: null,
        docked: true,
        dist_from_star_ls: null,
      },
      suits,
    });
    expect(panel(owned("upgrade_suit", { label: "Up" }), j).rows).toContainEqual({
      text: "  Up",
      right: "which suit?",
      detail: "ask Claude to set its suit_id (journal_on_foot)",
      tone: "warn",
    });
  });
});

describe("the build panel on foot", () => {
  it("names the loadout's suit, waits on gear to buy, and says what is short and where to get it", () => {
    const locker = box([["healthmonitor", 1]]);
    const j = journal([docked(1, "Kuwemaki", "Mitchell Ring")], {
      location: {
        system: "Kuwemaki",
        station: "Mitchell Ring",
        station_type: null,
        docked: true,
        dist_from_star_ls: null,
      },
      locker,
    });
    const p = panel(loadout(), j);
    expect(p.subtitle).toBe("Dominator loadout · stop 1/3");
    expect(p.rows).toContainEqual({ text: "  Buy Dominator G3" });
    expect(p.rows).toContainEqual({ text: "  Upgrade Dominator to G4", right: "after buy" });
    // With its suit bought: what it costs, and the resource short, with the stop that trades for it.
    const owned = loadout();
    owned.stops[0]!.actions![0]!.status = "done";
    owned.stops[0]!.actions![1]!.suit_id = 77;
    const q = panel(owned, j);
    expect(q.rows).toContainEqual({
      text: "  Upgrade Dominator to G4",
      right: "100",
      detail: "short 1 Health Monitor (have 1/2) · trade at stop 2",
    });
  });

  it("counts needs in the ship locker only, and shows what a bartender trade pays", () => {
    const owned = loadout();
    owned.stops[0]!.actions![0]!.status = "done";
    owned.stops[0]!.actions![1]!.suit_id = 77;
    owned.stops[1]!.actions![0]!.paid = { material: "Graphene", count: 10 };
    const at = (station: string) =>
      journal([docked(1, "Kuwemaki", "Mitchell Ring")], {
        location: {
          system: "Kuwemaki",
          station,
          station_type: null,
          docked: true,
          dist_from_star_ls: null,
        },
        // Two in the backpack: they are not spent until moved to the locker on boarding.
        locker: box([
          ["healthmonitor", 1],
          ["graphene", 3],
        ]),
        backpack: box([["healthmonitor", 2]]),
      });
    const rows = panel(owned, at("Mitchell Ring")).rows;
    expect(rows).toContainEqual(
      expect.objectContaining({ detail: "short 1 Health Monitor (have 1/2) · trade at stop 2" }),
    );
    owned.stops[0]!.status = "done";
    for (const x of owned.stops[0]!.actions!) x.status = "done";
    expect(panel(owned, at("Mitchell Ring")).rows).toContainEqual({
      text: "  Trade for 2 Health Monitor",
      detail: "have 3/10 Graphene",
    });
  });

  it("says to equip the suit to check a modification after a visit to its engineer", () => {
    const p = loadout();
    for (const a of p.stops[0]!.actions!) a.status = "done";
    p.stops[0]!.status = "done";
    p.stops[1]!.status = "done";
    p.stops[1]!.actions![0]!.status = "done";
    p.stops[2]!.actions![0]!.suit_id = 77;
    const j = journal([docked(5, "Orishis", "The Jackrabbit")], {
      location: {
        system: "Orishis",
        station: "The Jackrabbit",
        station_type: null,
        docked: true,
        dist_from_star_ls: null,
      },
    });
    expect(panel(p, j).rows).toContainEqual({
      text: "  Apply Extra Ammo Capacity",
      right: "equip to check",
    });
    // Come to the settlement, not docked there: a visit too.
    const near = ev(5, "ApproachSettlement", {
      Name: "$Settlement:#index=1;",
      Name_Localised: "The Jackrabbit",
      StarSystem: "Orishis",
    });
    expect(judgeBuild(p, journal([near])).visited.has(2)).toBe(true);
  });
});

describe("ActionFinisher on foot", () => {
  it("writes a bought suit's ID into the actions with its gear key, once", async () => {
    const store = new Map<string, Plan>();
    const p = loadout();
    store.set(p.id, p);
    const gear: unknown[] = [];
    const f = new ActionFinisher({
      plans: () =>
        ({
          get: async (id: string) => structuredClone(store.get(id)!),
          updateAction: async (
            id: string,
            ref: { stop: { index?: number }; action: string },
            patch: ActionPatch,
          ) => {
            const q = structuredClone(store.get(id)!);
            Object.assign(
              q.stops[ref.stop.index!]!.actions!.find((a) => a.id === ref.action)!,
              patch,
            );
            q.updated_at = iso(100 + gear.length);
            store.set(id, q);
            return structuredClone(q);
          },
          updateStop: async () => structuredClone(store.get(p.id)!),
          setBuildShip: async () => structuredClone(store.get(p.id)!),
          setGearId: async (id: string, g: string, ids: { suit_id?: number }) => {
            gear.push([g, ids]);
            const q = structuredClone(store.get(id)!);
            for (const st of q.stops)
              for (const a of st.actions ?? []) if (a.gear === g) a.suit_id ??= ids.suit_id;
            q.updated_at = iso(200);
            store.set(id, q);
            return structuredClone(q);
          },
        }) as never,
      activity: () => null,
      copy: () => {},
      notice: () => {},
      warn: () => {},
    });
    const j = journal([buySuit(5)]);
    await f.finish({ note: p, plans: [], journal: j, activity: null });
    await f.finish({ note: store.get(p.id)!, plans: [], journal: j, activity: null });
    expect(gear).toEqual([["dom", { suit_id: 77 }]]);
    // A buy marked done by hand takes the newest such buy of gear still owned, that no other
    // gear key has.
    const hand = loadout();
    hand.stops[0]!.actions![0]!.status = "done";
    const dom = (id: number) => ({
      id,
      type: "tacticalsuit",
      name: "Dominator",
      grade: 3,
      mods: [],
    });
    const buys = [buySuit(-200, 3, 54), buySuit(-100, 3, 55)];
    expect(judgeBuild(hand, journal(buys, { suits: [dom(54), dom(55)] })).gearIds).toEqual([
      { gear: "dom", suit_id: 55 },
    ]);
    // 55 sold since: the older one, still owned.
    hand.id = `${hand.id}-sold`;
    expect(judgeBuild(hand, journal(buys, { suits: [dom(54)] })).gearIds).toEqual([
      { gear: "dom", suit_id: 54 },
    ]);
    // A skipped buy bought nothing: no ID for its gear.
    hand.id = `${hand.id}-skip`;
    hand.stops[0]!.actions![0]!.status = "skipped";
    expect(judgeBuild(hand, journal(buys, { suits: [dom(54), dom(55)] })).gearIds).toEqual([]);
    // A buy with its ID in the plan gives that one, not another purchase's.
    hand.id = `${hand.id}-own`;
    hand.stops[0]!.actions![0]!.status = "done";
    hand.stops[0]!.actions![0]!.suit_id = 54;
    expect(judgeBuild(hand, journal(buys, { suits: [dom(54), dom(55)] })).gearIds).toEqual([
      { gear: "dom", suit_id: 54 },
    ]);
    delete hand.stops[0]!.actions![0]!.suit_id;
    // 55 is another gear key's already: not this one's too.
    hand.id = `${hand.id}-taken`;
    hand.stops[1]!.actions!.push(act({ id: "other", kind: "upgrade_suit", suit_id: 55, grade: 5 }));
    expect(judgeBuild(hand, journal(buys, { suits: [dom(54), dom(55)] })).gearIds).toEqual([
      { gear: "dom", suit_id: 54 },
    ]);
    expect(store.get(p.id)!.stops[2]!.actions![0]!.suit_id).toBe(77);
  });
});
