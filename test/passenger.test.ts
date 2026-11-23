import { describe, expect, it } from "vitest";
import type { JournalEvent, Mission, Plan } from "ed-mcp/journal";
import { buildHud, currentMode, type HudInput } from "../src/core/hud/hud.js";
import { HUD_EVENTS, journalMode, noteMode } from "../src/core/hud/mode.js";
import { berths, drops, goodsName, isRun, passengerPanel } from "../src/core/hud/passenger.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

/** Every mode on. */
const ALL = () => true;
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
let t = 0;
const ev = (event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: new Date(NOW - 3_600_000 + t++ * 1000).toISOString(),
  event,
  ...extra,
});
const hours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const mission = (id: number, o: Partial<Mission>): Mission =>
  ({
    id,
    name: `Mission_${id}`,
    faction: null,
    destination_system: "Ochosi",
    destination_station: "Perez Market",
    expires: hours(24),
    reward: 1_000_000,
    passengers: null,
    passenger_type: null,
    vips: null,
    wanted: null,
    commodity: null,
    count: null,
    kill_count: null,
    target_faction: null,
    accepted: null,
    status: "active",
    origin_system: "Sol",
    origin_station: "Abraham Lincoln",
    ...o,
  }) as Mission;

const loadout = ev("Loadout", {
  Modules: [
    { Item: "int_passengercabin_size5_class1" },
    { Item: "int_passengercabin_size4_class2" },
    { Item: "int_cargorack_size4_class1" },
  ],
});

const plan = (stops: Partial<Plan["stops"][number]>[]): Plan =>
  ({
    id: "missions",
    name: "Mission run",
    items: [],
    stops: stops.map((s) => ({ purpose: "x", status: "todo", system: "X", ...s })),
    created_at: "",
    updated_at: "",
  }) as Plan;

describe("passenger missions", () => {
  it("knows which missions carry people or goods", () => {
    expect(isRun(mission(1, { passengers: 4 }))).toBe(true);
    expect(isRun(mission(2, { commodity: "Gold", count: 10 }))).toBe(true);
    expect(isRun(mission(3, { kill_count: 20, commodity: "x", count: 1 }))).toBe(false);
    expect(isRun(mission(4, {}))).toBe(false);
    // A source or collect mission has goods but no destination.
    expect(isRun(mission(5, { commodity: "Tea", count: 20, destination_system: null }))).toBe(
      false,
    );
  });

  it("counts the berths in the fitted cabins", () => {
    expect(berths([loadout])).toBe(22);
    expect(berths([])).toBeNull();
    // The newest Loadout: after a refit, or in another ship.
    const refit = ev("Loadout", { Modules: [{ Item: "int_passengercabin_size4_class2" }] });
    expect(berths([loadout, refit])).toBe(6);
  });

  it("groups missions where they are handed over", () => {
    const d = drops([
      mission(1, { passengers: 4 }),
      mission(2, { passengers: 2 }),
      mission(3, { passengers: 1, status: "complete" }),
      mission(4, { passengers: 1, destination_system: null }),
    ]);
    expect(d.map((x) => [x.system, x.missions.length, x.handIn])).toEqual([
      ["Ochosi", 2, false],
      ["Sol", 1, true],
    ]);
  });
});

describe("passengerPanel", () => {
  const missions = [
    mission(1, { passengers: 6, vips: true, expires: hours(1) }),
    mission(2, {
      passengers: 4,
      wanted: true,
      destination_system: "Ngalinn",
      destination_station: "Haber Hub",
    }),
    mission(3, {
      commodity: "Gold",
      count: 32,
      destination_system: "Wolf 397",
      destination_station: "Brooks Estate",
      expires: hours(50),
    }),
    mission(4, { passengers: 2, status: "complete" }),
  ];

  it("lists each destination with passengers, flags and expiry, soonest first", () => {
    const p = passengerPanel({ missions, events: [loadout], plan: null, now: NOW })!;
    expect(p.title).toBe("PASSENGERS");
    // The 2 passengers redirected home to hand in are still aboard.
    expect(p.right).toBe("12/22 berths · 4.0M");
    expect(p.rows.slice(0, 4)).toEqual([
      { text: "Ochosi · Perez Market", right: "6 pax (6 VIP)  1h 0m", tone: "warn" },
      { text: "Ngalinn · Haber Hub", right: "4 pax (4 wanted)  1d 0h", tone: undefined },
      // Redirected home: the passengers fly back before the deadline.
      { text: "Sol · Abraham Lincoln", right: "2 pax · hand in  1d 0h", tone: "dim" },
      { text: "Wolf 397 · Brooks Estate", right: "32 t Gold  2d 2h", tone: undefined },
    ]);
    expect(p.rows[4]).toEqual({ text: "No mission route: ask Claude to plan one", tone: "dim" });
    expect(p.footer).toEqual(["4 missions · 1 to hand in"]);
  });

  it("follows the plan's order and says when new missions are not in it", () => {
    const route = plan([
      { system: "Wolf 397", station: "Brooks Estate", missions: [3] },
      { system: "Ngalinn", station: "Haber Hub", missions: [2] },
      { system: "Ochosi", station: "Perez Market", missions: [], status: "done" },
    ]);
    const p = passengerPanel({ missions, events: [], plan: route, now: NOW })!;
    expect(p.rows.map((r) => r.text).slice(0, 2)).toEqual([
      "Wolf 397 · Brooks Estate",
      "Ngalinn · Haber Hub",
    ]);
    expect(p.rows.at(-1)).toEqual({
      text: "Route stale: 1 new mission. Ask Claude to re-route",
      tone: "warn",
    });
    // A stop marked done with the route key, its mission still open, is still the route.
    const stepped = plan([
      { system: "Wolf 397", station: "Brooks Estate", missions: [3] },
      { system: "Ngalinn", station: "Haber Hub", missions: [2] },
      { system: "Ochosi", station: "Perez Market", missions: [1], status: "done" },
    ]);
    const on = passengerPanel({ missions, events: [], plan: stepped, now: NOW })!;
    expect(on.rows.some((r) => r.text.startsWith("Route stale"))).toBe(false);
    // A plan that covers every mission says nothing.
    const full = plan([{ system: "Ochosi", missions: [1, 2, 3] }]);
    const ok = passengerPanel({ missions, events: [], plan: full, now: NOW })!;
    expect(ok.rows.some((r) => r.text.startsWith("Route stale"))).toBe(false);
    // A plan read without the missions each stop serves is still a route.
    const old = plan([{ system: "Ochosi", kind: "mission" }]);
    const quiet = passengerPanel({ missions, events: [], plan: old, now: NOW })!;
    expect(quiet.rows.some((r) => /Route stale|No mission route/.test(r.text))).toBe(false);
  });

  it("is titled for deliveries without passengers, and null with nothing to do", () => {
    const p = passengerPanel({
      missions: [mission(1, { commodity: "Gold", count: 5 })],
      events: [],
      plan: null,
      now: NOW,
    })!;
    expect(p.title).toBe("DELIVERIES");
    expect(p.right).toBe("1.0M");
    // A journal symbol with no localised name is shown readably.
    const raw = passengerPanel({
      missions: [mission(1, { commodity: "$gold_name;", count: 5 })],
      events: [],
      plan: null,
      now: NOW,
    })!;
    expect(raw.rows[0]!.right).toMatch(/^5 t Gold/);
    expect(goodsName("$PowerGenerators_Name;")).toBe("Power Generators");
    expect(goodsName("$Agronomic_Treatment_name;")).toBe("Agronomic Treatment");
    expect(goodsName("Liquid Oxygen")).toBe("Liquid Oxygen");
    expect(passengerPanel({ missions: [], events: [], plan: null, now: NOW })).toBeNull();
    // Passengers left only to hand in still make it a passenger run.
    const done = passengerPanel({
      missions: [mission(1, { passengers: 4, status: "complete" })],
      events: [],
      plan: null,
      now: NOW,
    })!;
    expect(done.title).toBe("PASSENGERS");
    // Every mission ready to hand in: the run is done.
    expect(done.right).toBe("4 berths · 1.0M · ✓");
    expect(done.tone).toBe("good");
    const open = passengerPanel({
      missions: [mission(1, { passengers: 4, status: "complete" }), mission(2, { passengers: 2 })],
      events: [],
      plan: null,
      now: NOW,
    })!;
    expect(open.tone).toBeUndefined();
  });

  it("follows the route's visit order, not the order the stops are stored in", () => {
    const route = {
      ...plan([
        { system: "Ngalinn", station: "Haber Hub", kind: "mission" },
        { system: "Wolf 397", station: "Brooks Estate", kind: "mission" },
      ]),
      route: {
        computed_at: "",
        from: "Sol",
        stops: ["Wolf 397", "Ngalinn"],
        total_min: 10,
        plotted: false,
        stop_indexes: [[1], [0]],
      },
    };
    const p = passengerPanel({ missions, events: [], plan: route, now: NOW })!;
    expect(p.rows[0]!.text).toBe("Wolf 397 · Brooks Estate");
  });

  it("orders by a plan stop that names only the system", () => {
    const route = plan([
      { system: "Wolf 397", kind: "mission" },
      { system: "Ochosi", kind: "mission" },
    ]);
    // Another plan's stops (an exobiology plan, say) do not order the run.
    const bio = plan([{ system: "Wolf 397", kind: "exobiology" }]);
    // Soonest expiry first instead.
    expect(passengerPanel({ missions, events: [], plan: bio, now: NOW })!.rows[0]!.text).toBe(
      "Ochosi · Perez Market",
    );
    const p = passengerPanel({ missions, events: [], plan: route, now: NOW })!;
    expect(p.rows[0]!.text).toBe("Wolf 397 · Brooks Estate");
  });
});

describe("passenger mode", () => {
  const taken = () => ev("MissionAccepted", { PassengerCount: 4, MissionID: 1 });
  it("turns on for a passenger or delivery mission while one is open", () => {
    expect(journalMode([taken()], false, false, ALL, true)?.mode).toBe("passenger");
    expect(journalMode([taken()], false, false, ALL, false)).toBeNull();
    const delivery = ev("MissionAccepted", {
      Commodity: "$Gold_Name;",
      Count: 10,
      DestinationSystem: "Wolf 397",
      MissionID: 2,
    });
    expect(journalMode([delivery], false, false, ALL, true)?.mode).toBe("passenger");
    const source = ev("MissionAccepted", { Commodity: "$Tea_Name;", Count: 20, MissionID: 3 });
    expect(journalMode([source], false, false, ALL, true)).toBeNull();
  });

  it("gives way to a newer activity, and to massacres", () => {
    expect(journalMode([taken(), ev("FSSDiscoveryScan")], false, false, ALL, true)?.mode).toBe(
      "exploration",
    );
    expect(journalMode([ev("FSSDiscoveryScan"), taken()], false, false, ALL, true)?.mode).toBe(
      "passenger",
    );
    const massacre = ev("MissionAccepted", { Name: "Mission_Massacre", KillCount: 9 });
    expect(journalMode([massacre, taken()], true, false, ALL, true)?.mode).toBe("massacre");
  });

  it("keeps every event the passenger rules read", () => {
    for (const e of ["Loadout", "MissionAccepted"]) expect(HUD_EVENTS).toContain(e);
  });

  it("follows the activity note", () => {
    expect(noteMode("missions")).toBe("passenger");
    expect(noteMode("hauling")).toBe("passenger");
  });

  it("builds the panel in the HUD", () => {
    const events = [loadout, taken()];
    const input: HudInput = {
      journal: {
        commander: null,
        credits: null,
        location: {
          system: "Sol",
          station: null,
          station_type: null,
          docked: false,
          dist_from_star_ls: null,
        },
        ship: {
          type: "python",
          id: null,
          name: null,
          ident: null,
          max_jump_range: null,
          cargo_capacity: null,
          fuel_capacity: null,
        },
        cargo: [],
        materials: { raw: [], manufactured: [], encoded: [] },
        missions: [mission(1, { passengers: 4 })],
        engineers: [],
        stored_modules: null,
        as_of: null,
        events,
      },
      status: null,
      nav: null,
      activity: null,
      plan: null,
      hotkey: null,
      samples: new Map(),
      known: null,
      settings: DEFAULT_SETTINGS.hud,
      now: NOW,
    };
    expect(currentMode(input)).toBe("passenger");
    expect(buildHud(input, null).panel?.title).toBe("PASSENGERS");

    // With the mode off, a run taken after a scan leaves the exploration panel showing.
    const scanned = {
      ...input,
      journal: { ...input.journal!, events: [ev("FSSDiscoveryScan"), ...events] },
    };
    const off = {
      ...scanned,
      settings: {
        ...DEFAULT_SETTINGS.hud,
        modes: { ...DEFAULT_SETTINGS.hud.modes, passenger: false },
      },
    };
    expect(currentMode(off)).toBe("exploration");

    // A turned-off mode newer than the run does not hide it.
    const sampled = {
      ...input,
      journal: { ...input.journal!, events: [...events, ev("ScanOrganic", { ScanType: "Log" })] },
      settings: {
        ...DEFAULT_SETTINGS.hud,
        modes: { ...DEFAULT_SETTINGS.hud.modes, exobiology: false },
      },
    };
    expect(currentMode(sampled)).toBe("passenger");

    // A scan after the run shows exploration; a missions or hauling note newer than both shows the
    // run again.
    const explored = {
      ...input,
      journal: { ...input.journal!, events: [...events, ev("FSSDiscoveryScan")] },
    };
    expect(currentMode(explored)).toBe("exploration");
    for (const kind of ["missions", "hauling"]) {
      const followed = {
        ...explored,
        activity: { kind, updated_at: new Date(NOW).toISOString() } as never,
      };
      expect(currentMode(followed)).toBe("passenger");
    }

    // A missions note with no run to show is not followed.
    const note = {
      ...scanned,
      journal: { ...scanned.journal, missions: [] },
      activity: { kind: "missions", updated_at: new Date(NOW).toISOString() } as never,
    };
    expect(currentMode(note)).toBe("exploration");

    // So is a note for a mode that is turned off.
    const mining = {
      ...note,
      activity: { kind: "mining", updated_at: new Date(NOW).toISOString() } as never,
      settings: {
        ...DEFAULT_SETTINGS.hud,
        modes: { ...DEFAULT_SETTINGS.hud.modes, mining: false },
      },
    };
    expect(currentMode(mining)).toBe("exploration");
  });
});
