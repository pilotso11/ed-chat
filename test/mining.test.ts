import { describe, expect, it, vi } from "vitest";
import type { JournalEvent } from "ed-mcp/journal";
import { buildHud, currentMode, type HudInput } from "../src/core/hud/hud.js";
import {
  carrierState,
  commodityKey,
  commodityName,
  holdOf,
  judge,
  miningPanel,
  miningState,
  minedWaiting,
  refinedKinds,
  padFor,
  pickSell,
  sellQueries,
} from "../src/core/hud/mining.js";
import { journalMode, noteMode } from "../src/core/hud/mode.js";
import { parseSellHits, sellSearchBody, SellPrices, type SellHit } from "../src/core/hud/sell.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
let t = 0;
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
/** An event t seconds after T0, one second after the last unless given. */
const ev = (event: string, extra: Record<string, unknown> = {}, s?: number): JournalEvent => {
  t = s ?? t + 1;
  return { timestamp: at(t), event, ...extra };
};
const prospect = (materials: [string, number][], extra: Record<string, unknown> = {}) =>
  ev("ProspectedAsteroid", {
    Materials: materials.map(([Name, Proportion]) => ({ Name, Proportion })),
    Content: "$AsteroidMaterialContent_High;",
    Remaining: 100,
    ...extra,
  });
const refined = (name: string) =>
  ev("MiningRefined", { Type: `$${name.toLowerCase()}_name;`, Type_Localised: name });
const M = DEFAULT_SETTINGS.hud.mining;

const hit = (o: Partial<SellHit>): SellHit => ({
  station: "Port",
  system: "Sol",
  distanceLy: 10,
  arrivalLs: 100,
  price: 200_000,
  demand: 5000,
  largePad: true,
  mediumPad: true,
  carrier: false,
  marketId: 1,
  updatedAt: null,
  ...o,
});

describe("commodity names", () => {
  it("matches every way the journal names a commodity", () => {
    expect(commodityKey("$platinum_name;")).toBe("platinum");
    expect(commodityKey("Platinum")).toBe("platinum");
    expect(commodityKey("LowTemperatureDiamond")).toBe("lowtemperaturediamond");
    expect(commodityKey("Low Temperature Diamonds")).toBe("lowtemperaturediamond");
    expect(commodityKey("Void Opals")).toBe("opal");
    expect(commodityKey("Limpet")).toBe("drones");
  });

  it("gives the market's English name", () => {
    expect(commodityName("lowtemperaturediamond")).toBe("Low Temperature Diamonds");
    expect(commodityName("opal")).toBe("Void Opal");
    expect(commodityName("unknownthing", "UnknownThing")).toBe("Unknown Thing");
  });
});

describe("mining mode", () => {
  it("turns on for a prospector, a prospect, refining or a cracked asteroid", () => {
    expect(journalMode([ev("LaunchDrone", { Type: "Prospector" })], false)?.mode).toBe("mining");
    expect(journalMode([ev("LaunchDrone", { Type: "Collection" })], false)).toBeNull();
    expect(journalMode([prospect([["Platinum", 30]])], false)?.mode).toBe("mining");
    expect(journalMode([refined("Platinum")], false)?.mode).toBe("mining");
    expect(journalMode([ev("AsteroidCracked", { Body: "X 1 A Ring" })], false)?.mode).toBe(
      "mining",
    );
  });

  it("stays on after a jump while mined cargo is aboard, to sell it", () => {
    const events = [refined("Platinum"), ev("FSDJump")];
    expect(journalMode(events, false, true)?.mode).toBe("mining");
    expect(journalMode(events, false, false)).toBeNull();
    // Before leaving, an empty hold is just the start of mining.
    expect(journalMode([refined("Platinum")], false, false)?.mode).toBe("mining");
  });

  it("follows the activity note", () => {
    expect(noteMode("mining")).toBe("mining");
  });

  it("lets massacre missions win while open", () => {
    const events = [
      ev("MissionAccepted", { Name: "Mission_Massacre", KillCount: 10, MissionID: 1 }),
      refined("Platinum"),
    ];
    expect(journalMode(events, true)?.mode).toBe("massacre");
  });
});

describe("miningState", () => {
  it("keeps the newest prospect, the ring and its hotspots", () => {
    const events = [
      ev("SAASignalsFound", {
        BodyName: "HIP 1 2 A Ring",
        Signals: [
          { Type: "Platinum", Count: 2 },
          { Type: "LowTemperatureDiamond", Type_Localised: "Low Temp. Diamonds", Count: 1 },
        ],
      }),
      ev("SupercruiseExit", { Body: "HIP 1 2 A Ring", BodyType: "PlanetaryRing" }),
      prospect([["gallite", 30]]),
      prospect(
        [
          ["gallite", 10],
          ["Platinum", 31.4],
        ],
        { MotherlodeMaterial: "Alexandrite", Remaining: 60 },
      ),
    ];
    const s = miningState(events, T0 + t * 1000);
    expect(s.ring).toBe("HIP 1 2 A Ring");
    expect(s.hotspots).toEqual([
      { name: "Platinum", count: 2 },
      { name: "Low Temperature Diamonds", count: 1 },
    ]);
    expect(s.prospect?.materials[0]).toEqual({ key: "platinum", name: "Platinum", percent: 31.4 });
    expect(s.prospect?.motherlode).toBe("Alexandrite");
    expect(s.prospect?.remaining).toBe(60);
    expect(s.prospects).toHaveLength(2);
  });

  it("forgets the prospect and ring on a jump, and the session on a new game", () => {
    const events = [prospect([["Platinum", 30]]), refined("Platinum"), ev("FSDJump")];
    const s = miningState(events, T0 + t * 1000);
    expect(s.prospect).toBeNull();
    expect(s.refined.get("platinum")).toBe(1);
    const after = miningState([...events, ev("LoadGame")], T0 + t * 1000);
    expect(after.refined.size).toBe(0);
    expect(after.prospects).toHaveLength(0);
  });

  it("takes the ring from Status.json", () => {
    expect(miningState([], T0, "Col 285 1 B Ring").ring).toBe("Col 285 1 B Ring");
    expect(miningState([], T0, "Col 285 1").ring).toBeNull();
  });

  it("gives tons per hour once mining has gone on long enough", () => {
    const events = [ev("LaunchDrone", { Type: "Prospector" }, 0)];
    // 20 t over 10 minutes.
    for (let i = 1; i <= 20; i++)
      events.push(ev("MiningRefined", { Type: "$platinum_name;" }, i * 30));
    expect(miningState(events, T0 + 600_000).rate).toBe(120);
    expect(miningState(events.slice(0, 3), T0 + 60_000).rate).toBeNull();
    // Nothing refined for a quarter of an hour: no rate.
    expect(miningState(events, T0 + 600_000 + 16 * 60_000).rate).toBeNull();
  });
});

describe("the hold", () => {
  it("counts mined cargo and limpets, not mission cargo", () => {
    const h = holdOf([
      { name: "Limpet", count: 18, stolen: false, mission_id: null },
      { name: "platinum", count: 40, stolen: false, mission_id: null },
      { name: "Gold", count: 10, stolen: false, mission_id: 7 },
      { name: "Fish", count: 5, stolen: false, mission_id: null },
    ]);
    expect(h.limpets).toBe(18);
    expect([...h.mined]).toEqual([["platinum", 40]]);
    expect(h.used).toBe(73);
  });
});

describe("carrierState", () => {
  const ID = 3715702784;
  it("is null without a carrier", () => {
    expect(carrierState([ev("FSDJump")], T0)).toBeNull();
    expect(
      carrierState([ev("CarrierLocation", { CarrierType: "SquadronCarrier", CarrierID: 9 })], T0),
    ).toBeNull();
  });

  it("finds the carrier, its location and its free space", () => {
    const events = [
      ev("CarrierLocation", { CarrierType: "FleetCarrier", CarrierID: ID, StarSystem: "Belach" }),
      ev("CarrierStats", {
        CarrierID: ID,
        Callsign: "XFZ-12K",
        Name: "DISTANT HORIZONS",
        SpaceUsage: { FreeSpace: 10_000 },
      }),
      // At a squadron carrier: not this carrier's cargo.
      ev("Docked", { MarketID: 777, StationName: "SQN-001", StarSystem: "Belach" }),
      ev("CargoTransfer", { Transfers: [{ Type: "painite", Count: 99, Direction: "tocarrier" }] }),
      ev("Undocked"),
      ev("Docked", { MarketID: ID, StationName: "XFZ-12K", StarSystem: "Belach" }),
      ev("CargoTransfer", {
        Transfers: [{ Type: "platinum", Count: 200, Direction: "tocarrier" }],
      }),
      ev("CargoTransfer", { Transfers: [{ Type: "platinum", Count: 20, Direction: "toship" }] }),
      ev("MarketSell", { MarketID: ID, Type: "osmium", Count: 50 }),
      ev("MarketSell", { MarketID: 5, Type: "osmium", Count: 999 }),
    ];
    const c = carrierState(events, T0 + t * 1000)!;
    expect(c.callsign).toBe("XFZ-12K");
    expect(c.system).toBe("Belach");
    expect(c.freeSpace).toBe(10_000 - 200 + 20 - 50);
    expect([...c.moved]).toEqual([
      ["platinum", 180],
      ["osmium", 50],
    ]);
  });

  it("shows a booked jump until it leaves, then the new system", () => {
    const departs = at(t + 900);
    const events = [
      ev("CarrierLocation", { CarrierID: ID, StarSystem: "Belach" }),
      ev("CarrierJumpRequest", { CarrierID: ID, SystemName: "Ngalinn", DepartureTime: departs }),
    ];
    const before = carrierState(events, T0 + t * 1000)!;
    expect(before.system).toBe("Belach");
    expect(before.jumping?.system).toBe("Ngalinn");
    const after = carrierState(events, Date.parse(departs) + 1000)!;
    expect(after.system).toBe("Ngalinn");
    expect(after.jumping).toBeNull();
    const cancelled = carrierState(
      [...events, ev("CarrierJumpCancelled", { CarrierID: ID })],
      Date.parse(departs) + 1000,
    )!;
    expect(cancelled.system).toBe("Belach");
  });
});

describe("where to sell", () => {
  it("knows the pad each ship needs", () => {
    expect(padFor("type9")).toBe("L");
    expect(padFor("Python")).toBe("M");
    expect(padFor("cobramkiii")).toBe("S");
    expect(padFor(null)).toBeNull();
  });

  it("picks the best price that fits the ship and takes the load, and a nearer place", () => {
    const hits = [
      hit({ station: "Big", price: 250_000, distanceLy: 40, largePad: false }),
      hit({ station: "Thin", price: 240_000, distanceLy: 30, demand: 10 }),
      hit({ station: "Best", price: 230_000, distanceLy: 20 }),
      hit({ station: "Near", price: 215_000, distanceLy: 3 }),
      hit({ station: "Cheap", price: 150_000, distanceLy: 1 }),
      hit({ station: "Mine", price: 300_000, distanceLy: 0, marketId: 99 }),
    ];
    const p = pickSell(hits, 100, "L", 99)!;
    expect(p.best.station).toBe("Best");
    expect(p.near?.station).toBe("Near");
    // Nothing takes the whole load: the best price anyway.
    expect(pickSell([hit({ demand: 5, station: "A" })], 100, "L", null)?.best.station).toBe("A");
    expect(pickSell([hit({ largePad: false, mediumPad: false })], 1, "M", null)).toBeNull();
  });

  it("searches around the ship, or around the carrier with what it holds", () => {
    const carrier = {
      id: 1,
      callsign: "XFZ-12K",
      name: null,
      system: "Belach",
      jumping: null,
      freeSpace: 1000,
      moved: new Map([["platinum", 300]]),
    };
    const hold = new Map([
      ["platinum", 50],
      ["osmium", 80],
    ]);
    const ship = sellQueries({ system: "HIP 1", hold, carrier, shipType: "type9", settings: M });
    expect(ship.map((q) => [q.name, q.tons, q.query.near, q.query.radiusLy])).toEqual([
      ["Osmium", 80, "HIP 1", 100],
      ["Platinum", 50, "HIP 1", 100],
    ]);
    expect(ship[0]!.query.pad).toBe("L");
    const fromCarrier = sellQueries({
      system: "HIP 1",
      hold,
      carrier,
      shipType: "python",
      settings: { ...M, useCarrier: true },
    });
    expect(fromCarrier.map((q) => [q.name, q.tons, q.query.near, q.query.radiusLy])).toEqual([
      ["Platinum", 350, "Belach", 500],
      ["Osmium", 80, "Belach", 500],
    ]);
    expect(fromCarrier[0]!.query.pad).toBe("M");
  });
});

describe("judge", () => {
  it("marks a rock worth mining against the targets", () => {
    const p = miningState(
      [
        prospect([
          ["gallite", 40],
          ["Platinum", 22],
        ]),
      ],
      T0,
    ).prospect!;
    expect(judge(p, M.targets)).toEqual({ name: "Platinum", percent: 22, worth: true });
    expect(judge(p, { Platinum: 30 })?.worth).toBe(false);
    expect(judge(p, {})).toEqual({ name: "Gallite", percent: 40, worth: false });
  });
});

describe("miningPanel", () => {
  const cargo = [
    { name: "Limpet", count: 10, stolen: false, mission_id: null },
    { name: "platinum", count: 246, stolen: false, mission_id: null },
  ];
  const base = () => ({
    system: "HIP 1",
    state: miningState(
      [
        ev("SupercruiseExit", { Body: "HIP 1 2 A Ring", BodyType: "PlanetaryRing" }),
        prospect([
          ["Platinum", 31.4],
          ["gallite", 5],
        ]),
        refined("Platinum"),
        refined("Platinum"),
      ],
      T0 + t * 1000,
    ),
    cargo,
    capacity: 256,
    shipType: "type9",
    carrier: null,
    settings: M,
    now: T0 + t * 1000,
  });

  it("shows the rock, the hold, refined tons and where to sell", () => {
    const sell = vi.fn(() => [
      hit({ station: "Haber Hub", system: "Ngalinn", price: 243_500, distanceLy: 12 }),
      hit({ station: "Brooks Estate", system: "Wolf 397", price: 230_000, distanceLy: 4 }),
    ]);
    const p = miningPanel({ ...base(), sell });
    expect(p.subtitle).toBe("2 A Ring");
    expect(p.rows[0]).toMatchObject({ text: "Platinum 31.4% · High", right: "MINE", tone: "good" });
    expect(p.rows[0]!.detail).toBe("Gallite 5.0%");
    expect(p.rows.find((r) => r.text.startsWith("Hold"))).toMatchObject({
      text: "Hold 256/256 t",
      right: "0 t free · 10 limpets",
      tone: "warn",
    });
    expect(p.rows.find((r) => r.text === "Sell Platinum 246 t")).toMatchObject({
      right: "244k · 12 ly",
      detail: "Haber Hub, Ngalinn",
    });
    expect(p.rows.find((r) => r.text === "  or nearer")?.detail).toBe("Brooks Estate, Wolf 397");
    expect(p.rows.find((r) => r.text.startsWith("Refined"))).toMatchObject({
      text: "Refined: Platinum 2 t",
      right: "~487k",
    });
    expect(p.footer).toEqual(["Session: 1 prospected · 1 worth mining"]);
    // A full hold copies the best buyer's system.
    expect(p.copy?.text).toBe("Ngalinn");
  });

  it("says when prices are loading or no one buys", () => {
    const pending = miningPanel({ ...base(), sell: () => "pending" });
    expect(pending.rows.find((r) => r.text.startsWith("Sell"))?.right).toBe("looking up…");
    const none = miningPanel({ ...base(), sell: () => [] });
    expect(none.rows.find((r) => r.text.startsWith("Sell"))?.right).toBe("no buyer within 100 ly");
    const off = miningPanel(base());
    expect(off.rows.some((r) => r.text.startsWith("Sell"))).toBe(false);
  });

  it("shows the carrier and copies nothing when the load goes to it", () => {
    const p = miningPanel({
      ...base(),
      settings: { ...M, useCarrier: true },
      carrier: {
        id: 1,
        callsign: "XFZ-12K",
        name: null,
        system: "HIP 1",
        jumping: null,
        freeSpace: 8210,
        moved: new Map([["platinum", 412]]),
      },
      sell: () => [hit({ system: "Ngalinn" })],
    });
    expect(p.rows.find((r) => r.text.startsWith("Carrier"))).toMatchObject({
      text: "Carrier XFZ-12K · HIP 1",
      right: "412 t moved · 8,210 t free",
    });
    expect(p.rows.find((r) => r.text.startsWith("Sell"))?.text).toBe("Sell Platinum 658 t");
    expect(p.copy).toBeUndefined();
  });

  it("shows a price's age once it is over a day old", () => {
    const p = miningPanel({
      ...base(),
      sell: () => [hit({ station: "Old Hub", system: "Ngalinn", updatedAt: at(t - 3 * 86_400) })],
    });
    expect(p.rows.find((r) => r.text.startsWith("Sell"))?.detail).toBe("Old Hub, Ngalinn · 3d old");
  });

  it("asks for a prospect before the first one", () => {
    const p = miningPanel({ ...base(), state: miningState([], T0) });
    expect(p.rows[0]!.text).toBe("Prospect a rock");
  });
});

describe("the HUD in mining mode", () => {
  it("builds the mining panel from the journal", () => {
    const events = [prospect([["Platinum", 25]])];
    const input: HudInput = {
      journal: {
        commander: null,
        credits: null,
        location: {
          system: "HIP 1",
          station: null,
          station_type: null,
          docked: false,
          dist_from_star_ls: null,
        },
        ship: {
          type: "type9",
          name: null,
          ident: null,
          max_jump_range: null,
          cargo_capacity: 256,
          fuel_capacity: null,
        },
        cargo: [],
        materials: { raw: [], manufactured: [], encoded: [] },
        missions: [],
        engineers: [],
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
      now: T0 + t * 1000,
    };
    expect(currentMode(input)).toBe("mining");
    const v = buildHud(input, null);
    expect(v.panel?.title).toBe("MINING");
    expect(v.panel?.rows[0]?.right).toBe("MINE");
  });
});

describe("Spansh sale prices", () => {
  it("asks for buyers of the commodity, sorted by price", () => {
    const body = sellSearchBody(
      {
        near: "Sol",
        commodity: "Platinum",
        radiusLy: 100,
        pad: "L",
        carriers: false,
        maxAgeDays: 2,
      },
      T0,
    ) as { filters: Record<string, unknown>; sort: unknown; reference_system: string };
    expect(body.filters.market_updated_at).toEqual({
      comparison: "<=>",
      value: ["2026-11-19T10:00:00Z", "2026-11-22T10:00:00Z"],
    });
    expect(body.reference_system).toBe("Sol");
    expect(body.filters.has_large_pad).toEqual({ value: true });
    expect((body.filters.type as { value: string[] }).value).not.toContain("Drake-Class Carrier");
    expect(body.sort).toEqual([{ market_sell_price: [{ name: "Platinum", direction: "desc" }] }]);
    const withCarriers = sellSearchBody(
      {
        near: "Sol",
        commodity: "Platinum",
        radiusLy: 100,
        pad: null,
        carriers: true,
        maxAgeDays: 2,
      },
      T0,
    ) as { filters: Record<string, unknown> };
    expect(withCarriers.filters.type).toBeUndefined();
    expect(withCarriers.filters.has_large_pad).toBeUndefined();
    const medium = sellSearchBody(
      { near: "Sol", commodity: "Gold", radiusLy: 50, pad: "M", carriers: true, maxAgeDays: 2 },
      T0,
    ) as { filters: Record<string, unknown> };
    expect(medium.filters.medium_pads).toEqual({ comparison: "<=>", value: [1, 1000] });
  });

  it("reads the stations that buy", () => {
    const hits = parseSellHits(
      {
        results: [
          {
            name: "Haber Hub",
            system_name: "Ngalinn",
            distance: 12.3,
            distance_to_arrival: 450,
            has_large_pad: true,
            medium_pads: 4,
            type: "Coriolis Starport",
            market_id: 5,
            market: [
              { commodity: "Gold", sell_price: 50_000 },
              { commodity: "Platinum", sell_price: 243_500, demand: 900 },
            ],
          },
          { name: "No price", system_name: "X", market: [{ commodity: "Platinum" }] },
          {
            name: "XFZ-12K",
            system_name: "Y",
            distance: 3,
            type: "Drake-Class Carrier",
            market: [{ commodity: "Platinum", sell_price: 1 }],
          },
        ],
      },
      "Platinum",
    );
    expect(hits.map((h) => [h.station, h.price, h.demand, h.carrier])).toEqual([
      ["Haber Hub", 243_500, 900, false],
      ["XFZ-12K", 1, null, true],
    ]);
  });

  it("searches once, keeps the result, and says when it failed", async () => {
    let now = T0;
    const post = vi.fn(async () => ({
      results: [
        {
          name: "A",
          system_name: "S",
          distance: 1,
          market: [{ commodity: "Platinum", sell_price: 9 }],
        },
      ],
    }));
    const prices = new SellPrices(post, { now: () => now });
    const q = {
      near: "Sol",
      commodity: "Platinum",
      radiusLy: 100,
      pad: null,
      carriers: false,
      maxAgeDays: 2,
    };
    expect(prices.get(q)).toBe("pending");
    expect(prices.get(q)).toBe("pending");
    await vi.waitFor(() => expect(prices.get(q)).not.toBe("pending"));
    expect(post).toHaveBeenCalledTimes(1);
    expect((prices.get(q) as SellHit[])[0]!.price).toBe(9);
    // Half an hour later it searches again, showing the old prices meanwhile.
    now += 31 * 60_000;
    expect((prices.get(q) as SellHit[])[0]!.price).toBe(9);
    expect(post).toHaveBeenCalledTimes(2);

    const failing = new SellPrices(async () => Promise.reject(new Error("Spansh 503")), {
      now: () => now,
    });
    expect(failing.get(q)).toBe("pending");
    await vi.waitFor(() => expect(failing.get(q)).toBe("failed"));
  });
});

describe("mining edge cases", () => {
  const ID = 42;
  it("reads the carrier from a purchase, docking, a jump aboard and its market", () => {
    const events = [
      ev("CarrierBuy", { CarrierID: ID, Callsign: "ABC-123", Location: "Mizar" }),
      ev("CarrierStats", { CarrierID: ID, SpaceUsage: { FreeSpace: 500 } }),
      ev("Docked", { MarketID: ID, StationName: "ABC-123", StarSystem: "Alioth" }),
      ev("MarketBuy", { MarketID: ID, Type: "platinum", Count: 20 }),
      ev("CarrierJump", { MarketID: ID, StarSystem: "Merope" }),
      ev("CarrierJumpRequest", { CarrierID: ID, SystemName: "Maia" }),
    ];
    const c = carrierState(events, T0 + t * 1000)!;
    expect(c.callsign).toBe("ABC-123");
    expect(c.system).toBe("Merope");
    expect(c.freeSpace).toBe(520);
    // No departure time: about 15 minutes after booking.
    expect(c.jumping?.system).toBe("Maia");
    expect(carrierState(events, T0 + (t + 16 * 60) * 1000)!.system).toBe("Maia");
    // A new game session forgets what was moved.
    const moved = carrierState(
      [
        ...events,
        ev("Docked", { MarketID: ID, StarSystem: "Merope" }),
        ev("CargoTransfer", { Transfers: [{ Type: "painite", Count: 5, Direction: "tocarrier" }] }),
        ev("LoadGame"),
      ],
      T0 + t * 1000,
    )!;
    expect(moved.moved.size).toBe(0);
  });

  const state = (events: JournalEvent[]) => miningState(events, T0 + t * 1000);
  const panel = (over: Partial<Parameters<typeof miningPanel>[0]> = {}) =>
    miningPanel({
      system: "HIP 1",
      state: state([]),
      cargo: [],
      capacity: null,
      shipType: null,
      carrier: null,
      settings: M,
      now: T0 + t * 1000,
      ...over,
    });

  it("shows a motherlode, a worked rock, hotspots, the rate and the session", () => {
    const events = [
      ev("SAASignalsFound", { BodyName: "HIP 1 2 A Ring", Signals: [{ Type: "Painite" }] }),
      ev("AsteroidCracked", { Body: "HIP 1 2 A Ring" }, t + 1),
      prospect([["Painite", 10]], {
        MotherlodeMaterial: "Opal",
        MotherlodeMaterial_Localised: "Void Opal",
        Remaining: 40,
        Content: "$AsteroidMaterialContent_Low;",
      }),
    ];
    for (let i = 1; i <= 10; i++)
      events.push(ev("MiningRefined", { Type: "$painite_name;" }, t + 30));
    const p = panel({ state: state(events) });
    expect(p.right).toMatch(/t\/h$/);
    expect(p.rows[0]).toMatchObject({ text: "Painite 10.0% · Low · 40% left", right: "skip" });
    expect(p.rows[1]).toMatchObject({ text: "Motherlode: Void Opal", right: "crack" });
    expect(p.rows[2]!.text).toBe("Hotspots: Painite");
    expect(p.rows[3]).toMatchObject({ text: "Hold 0 t", right: "0 limpets", tone: "warn" });
    expect(p.footer[0]).toBe("Session: 1 prospected · 0 worth mining · 1 motherlode · 1 cracked");
    expect(p.rows.find((r) => r.text.startsWith("Refined"))?.right).toBeUndefined();
  });

  it("says when the carrier is unknown, jumping, or the lookup failed", () => {
    const cargo = [{ name: "osmium", count: 5, stolen: false, mission_id: null }];
    const unknown = panel({ settings: { ...M, useCarrier: true }, cargo });
    expect(unknown.rows.some((r) => r.text.startsWith("Carrier: not in the journal"))).toBe(true);
    const jumping = panel({
      settings: { ...M, useCarrier: true },
      carrier: {
        id: 1,
        callsign: null,
        name: null,
        system: null,
        jumping: { system: "Maia", departs: null },
        freeSpace: null,
        moved: new Map(),
      },
    });
    expect(jumping.rows.find((r) => r.text.startsWith("Carrier"))).toMatchObject({
      text: "Carrier · → Maia",
      right: "",
    });
    const failed = panel({ cargo, sell: () => "failed" });
    expect(failed.rows.find((r) => r.text.startsWith("Sell"))?.right).toBe("Spansh lookup failed");
    const carriers = panel({
      cargo,
      sell: () => [hit({ station: "FC", carrier: true, demand: 2 })],
    });
    expect(carriers.rows.find((r) => r.text.startsWith("Sell"))?.detail).toBe(
      "FC (carrier), Sol · demand 2",
    );
  });

  it("posts the search to Spansh", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const { postSpansh } = await import("../src/core/hud/sell.js");
    await expect(postSpansh("https://spansh.co.uk/api/stations/search", { a: 1 })).resolves.toEqual(
      {
        results: [],
      },
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: '{"a":1}' });
    await expect(postSpansh("https://x", {})).rejects.toThrow("Spansh 503");
    fetch.mockRestore();
  });
});

describe("after the review", () => {
  const cargo = (n: number) => [{ name: "platinum", count: n, stolen: false, mission_id: null }];
  const panel = (events: JournalEvent[], over: Partial<Parameters<typeof miningPanel>[0]> = {}) =>
    miningPanel({
      system: "HIP 1",
      state: miningState(events, T0 + t * 1000),
      cargo: cargo(256),
      capacity: 256,
      shipType: "type9",
      carrier: null,
      settings: M,
      now: T0 + t * 1000,
      sell: () => [hit({ station: "Haber Hub", system: "Ngalinn" })],
      ...over,
    });

  it("copies a full hold's buyer only while mining, once per trip", () => {
    const here = panel([prospect([["Platinum", 30]])]);
    expect(here.copy?.key).toBe("hold-full|");
    // After a jump toward the buyer the route copies the next stop instead.
    const away = panel([prospect([["Platinum", 30]]), ev("FSDJump")], { system: "Other" });
    expect(away.copy).toBeUndefined();
  });

  it("ends mining after a sale or a new game with nothing left, not with cargo waiting", () => {
    const sold = [refined("Platinum"), ev("MarketSell", { Type: "platinum", Count: 1 })];
    expect(journalMode(sold, false, false)).toBeNull();
    expect(journalMode(sold, false, true)?.mode).toBe("mining");
    expect(journalMode([refined("Platinum"), ev("LoadGame")], false, false)).toBeNull();
    // Prospecting again turns it back on.
    expect(journalMode([...sold, prospect([["Platinum", 30]])], false, false)?.mode).toBe("mining");
  });

  it("counts cargo on the carrier as waiting to be sold when selling from it", () => {
    const now = T0 + t * 1000;
    const events = [
      refined("Platinum"),
      ev("CarrierLocation", { CarrierID: 9, StarSystem: "Belach" }),
      ev("Docked", { MarketID: 9, StarSystem: "Belach" }),
      ev("CargoTransfer", {
        Transfers: [{ Type: "platinum", Count: 300, Direction: "tocarrier" }],
      }),
    ];
    expect(minedWaiting([], events, now, M)).toBe(false);
    expect(minedWaiting([], events, now, { ...M, useCarrier: true })).toBe(true);
    expect(minedWaiting(cargo(1), events, now, M)).toBe(true);
    // Bought Gold is not mined cargo.
    const gold = [{ name: "Gold", count: 300, stolen: false, mission_id: null }];
    expect(minedWaiting(gold, events, now, M)).toBe(false);
    expect(minedWaiting(cargo(1), [], now, M)).toBe(false);
  });

  it("counts transfers after logging in docked at the carrier", () => {
    const c = carrierState(
      [
        ev("CarrierLocation", { CarrierID: 9, StarSystem: "Belach" }),
        ev("Location", { Docked: true, MarketID: 9, StarSystem: "Belach" }),
        ev("CargoTransfer", { Transfers: [{ Type: "osmium", Count: 40, Direction: "tocarrier" }] }),
      ],
      T0 + t * 1000,
    )!;
    expect(c.moved.get("osmium")).toBe(40);
  });

  it("searches around a booked jump's destination, for refined cargo only", () => {
    const carrier = {
      id: 9,
      callsign: null,
      name: null,
      system: "Belach",
      jumping: { system: "Hub", departs: null },
      freeSpace: null,
      moved: new Map([
        ["platinum", 100],
        ["gold", 50],
      ]),
    };
    const q = sellQueries({
      system: "HIP 1",
      hold: new Map(),
      carrier,
      kinds: new Set(["platinum"]),
      shipType: null,
      settings: { ...M, useCarrier: true },
    });
    expect(q.map((x) => [x.name, x.tons, x.query.near])).toEqual([["Platinum", 100, "Hub"]]);
  });

  it("searches for void opals by the market's name", () => {
    expect(commodityName(commodityKey("$Opal_Name;"))).toBe("Void Opal");
  });

  it("leaves bought cargo out of the sell rows", () => {
    const p = panel([refined("Platinum"), prospect([["Platinum", 30]])], {
      events: [refined("Platinum")],
      cargo: [...cargo(10), { name: "Gold", count: 20, stolen: false, mission_id: null }],
    });
    expect(p.rows.filter((r) => r.text.startsWith("Sell")).map((r) => r.text)).toEqual([
      "Sell Platinum 10 t",
    ]);
  });

  it("prices refined commodities that are no longer aboard", () => {
    const events = [refined("Platinum"), refined("Osmium"), refined("Painite")];
    const seen: string[] = [];
    const p = panel(events, {
      cargo: cargo(10),
      sell: (q) => {
        seen.push(q.commodity);
        return q.commodity === "Painite" ? "pending" : [hit({ price: 100_000 })];
      },
    });
    expect(seen).toEqual(["Platinum", "Osmium", "Painite"]);
    // Painite has no price yet: the value is a floor.
    expect(p.rows.find((r) => r.text.startsWith("Refined"))?.right).toBe("~200k+");
  });

  it("forgets old failed searches", async () => {
    let now = T0;
    const prices = new SellPrices(async () => Promise.reject(new Error("offline")), {
      now: () => now,
    });
    const q = (i: number) => ({
      near: `S${i}`,
      commodity: "Platinum",
      radiusLy: 100,
      pad: null,
      carriers: false,
      maxAgeDays: 7,
    });
    for (let i = 0; i < 60; i++) prices.get(q(i));
    await vi.waitFor(() => expect(prices.get(q(59))).toBe("failed"));
    const failed = (prices as unknown as { failed: Map<string, number> }).failed;
    expect(failed.size).toBeLessThanOrEqual(50);
    now += 1;
  });
});

describe("after the third review", () => {
  it("searches from the mining system on the way to the buyer", () => {
    const events = [
      ev("FSDJump", { StarSystem: "HIP 1" }),
      refined("Platinum"),
      ev("FSDJump", { StarSystem: "Wolf 397" }),
    ];
    const state = miningState(events, T0 + t * 1000);
    expect(state.system).toBe("HIP 1");
    const seen: string[] = [];
    const p = miningPanel({
      system: "Wolf 397",
      state,
      events,
      cargo: [{ name: "platinum", count: 5, stolen: false, mission_id: null }],
      capacity: 10,
      shipType: "python",
      carrier: null,
      settings: M,
      now: T0 + t * 1000,
      sell: (q) => {
        seen.push(q.near);
        return [hit({})];
      },
    });
    expect(seen).toEqual(["HIP 1"]);
    expect(p.rows.find((r) => r.text.startsWith("Sell"))?.right).toBe("200k · 10 ly from HIP 1");
  });

  it("copies again after a sale, for the next full hold", () => {
    const base = [
      ev("FSDJump", { StarSystem: "HIP 1" }),
      refined("Platinum"),
      prospect([["Platinum", 30]]),
    ];
    const panel = (events: JournalEvent[]) =>
      miningPanel({
        system: "HIP 1",
        state: miningState(events, T0 + t * 1000),
        events,
        cargo: [{ name: "platinum", count: 10, stolen: false, mission_id: null }],
        capacity: 10,
        shipType: null,
        carrier: null,
        settings: M,
        now: T0 + t * 1000,
        sell: () => [hit({ station: "X", system: "Y" })],
      });
    const first = panel(base).copy?.key;
    const second = panel([...base, ev("MarketSell", { Type: "platinum", Count: 10 })]).copy?.key;
    expect(first).toBe("hold-full|");
    expect(second).toMatch(/^hold-full\|2026-11-21T/);
  });

  it("counts refined commodities until bought, however long ago, and skips unreadable ones", () => {
    const old = {
      timestamp: new Date(T0 - 2 * 86_400_000).toISOString(),
      event: "MiningRefined",
      Type: "$gold_name;",
    };
    expect([...refinedKinds([old, refined("Platinum"), ev("MiningRefined", {})])]).toEqual([
      "gold",
      "platinum",
    ]);
    const bought = [old, ev("MarketBuy", { Type: "gold", Count: 100 })];
    expect([...refinedKinds(bought)]).toEqual([]);
  });

  it("changes no mode for mining while the mining mode is off", () => {
    const events = [ev("FSSDiscoveryScan"), ev("LaunchDrone", { Type: "Prospector" })];
    expect(journalMode(events, false, false, true)?.mode).toBe("mining");
    expect(journalMode(events, false, false, false)?.mode).toBe("exploration");
  });

  it("counts the rate from when mining started again after a break", () => {
    const events = [ev("MiningRefined", { Type: "$platinum_name;" }, 0)];
    // Two hours docked, then 8 t over three and a half minutes.
    for (let i = 1; i <= 8; i++) {
      events.push(ev("MiningRefined", { Type: "$platinum_name;" }, 7200 + i * 30));
    }
    expect(miningState(events, T0 + (7200 + 240) * 1000).rate).toBe(137);
  });

  it("sells from a carrier known only by a booked jump", () => {
    const q = sellQueries({
      system: "HIP 1",
      hold: new Map([["platinum", 5]]),
      carrier: {
        id: 9,
        callsign: null,
        name: null,
        system: null,
        jumping: { system: "Hub", departs: null },
        freeSpace: null,
        moved: new Map(),
      },
      shipType: null,
      settings: { ...M, useCarrier: true },
    });
    expect(q[0]!.query.near).toBe("Hub");
  });

  it("leaves out a buyer with no distance", () => {
    const hits = parseSellHits(
      {
        results: [{ name: "A", system_name: "S", market: [{ commodity: "Gold", sell_price: 5 }] }],
      },
      "Gold",
    );
    expect(hits).toEqual([]);
  });
});

describe("after the fifth review", () => {
  it("counts fragments collected from a cracked core as mined", () => {
    const events = [ev("AsteroidCracked", { Body: "R" }), ev("CollectCargo", { Type: "opal" })];
    expect([...refinedKinds(events)]).toEqual(["opal"]);
    const opals = [{ name: "opal", count: 200, stolen: false, mission_id: null }];
    expect(minedWaiting(opals, events, T0 + t * 1000, M)).toBe(true);
    // Salvage that cannot be mined does not count.
    expect([...refinedKinds([ev("CollectCargo", { Type: "usscargoblackbox" })])]).toEqual([]);
  });

  it("keeps the mark when buying back from the player's own carrier", () => {
    const events = [
      ev("CarrierLocation", { CarrierID: 9, StarSystem: "Belach" }),
      refined("Platinum"),
      ev("MarketBuy", { MarketID: 9, Type: "platinum", Count: 50 }),
    ];
    expect(refinedKinds(events).has("platinum")).toBe(true);
    const elsewhere = [...events, ev("MarketBuy", { MarketID: 5, Type: "platinum", Count: 1 })];
    expect(refinedKinds(elsewhere).has("platinum")).toBe(false);
  });

  it("searches from the ship once it is a few jumps from the mining system", () => {
    const events = [ev("FSDJump", { StarSystem: "A" }), refined("Platinum")];
    for (const s of ["B", "C", "D"]) events.push(ev("FSDJump", { StarSystem: s }));
    expect(miningState(events, T0 + t * 1000).system).toBe("A");
    events.push(ev("FSDJump", { StarSystem: "E" }));
    expect(miningState(events, T0 + t * 1000).system).toBeNull();
    expect(miningState([...events.slice(0, 2), ev("LoadGame")], T0 + t * 1000).system).toBeNull();
  });

  it("knows the newer small hulls", () => {
    expect(padFor("smallcombat01_nx")).toBe("S");
  });
});

describe("after the sixth review", () => {
  it("does not count a canister salvaged away from mining", () => {
    const salvage = [ev("FSDJump", { StarSystem: "X" }), ev("CollectCargo", { Type: "gold" })];
    expect([...refinedKinds(salvage)]).toEqual([]);
    const cracked = [ev("AsteroidCracked", { Body: "R" }), ev("CollectCargo", { Type: "gold" })];
    expect([...refinedKinds(cracked)]).toEqual(["gold"]);
  });

  it("stops mining in the ring on entering supercruise or docking", () => {
    const events = [
      ev("SupercruiseExit", { Body: "X 1 A Ring", BodyType: "PlanetaryRing" }),
      prospect([["Platinum", 30]]),
      ev("Docked", { StationName: "Port" }),
    ];
    const s = miningState(events, T0 + t * 1000);
    expect([s.ring, s.prospect]).toEqual([null, null]);
    expect(s.prospects).toHaveLength(1);
  });
});
