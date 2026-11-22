import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStores } from "ed-mcp/journal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HudFeed } from "../src/core/hud/feed.js";
import { buildHud, type HudView } from "../src/core/hud/hud.js";
import { HUD_EVENTS } from "../src/core/hud/mode.js";
import { EXPLORATION_EVENTS } from "../src/core/hud/panels.js";
import { TRADE_EVENTS, tradeAdvance } from "../src/core/hud/trade.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

// These tests run the bundled ed-mcp for real. A journal file in a temporary folder is read by
// ed-mcp's journal service, the way ED Chat reads it, and the panel is built from the results.
// If a new ed-mcp changes what the panel shows, a test here fails before a release.

let dir: string;
let syncDir: string;
let start: number;
let t: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "edchat-journal-"));
  syncDir = await mkdtemp(path.join(tmpdir(), "edchat-sync-"));
  // A few minutes ago: recent enough that ed-mcp does not call the journal old.
  start = Date.now() - 5 * 60_000;
  t = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(syncDir, { recursive: true, force: true });
});

type Event = Record<string, unknown>;
const ev = (event: string, extra: Event = {}): Event => ({
  timestamp: new Date(start + t++ * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  event,
  ...extra,
});

const SYSTEM = "Test Sector AB-C d1";
const ADDRESS = 123456789;
const RADIUS = 2_000_000;

const arrive = (): Event[] => [
  ev("Fileheader", { part: 1, gameversion: "4.0.0.1", build: "r1" }),
  ev("Commander", { FID: "F1", Name: "Tester" }),
  ev("LoadGame", { Commander: "Tester", Ship: "anaconda", ShipID: 1, Credits: 1000 }),
  ev("FSDJump", {
    StarSystem: SYSTEM,
    SystemAddress: ADDRESS,
    StarPos: [100, 0, 100],
    JumpDist: 20,
    Body: SYSTEM,
    BodyID: 0,
    BodyType: "Star",
  }),
];

const planet = (bodyId: number): Event =>
  ev("Scan", {
    ScanType: "Detailed",
    BodyName: `${SYSTEM} ${bodyId}`,
    BodyID: bodyId,
    StarSystem: SYSTEM,
    SystemAddress: ADDRESS,
    DistanceFromArrivalLS: 500,
    PlanetClass: "Rocky body",
    Atmosphere: "thin carbon dioxide atmosphere",
    AtmosphereType: "CarbonDioxide",
    Volcanism: "",
    MassEM: 0.1,
    Radius: RADIUS,
    SurfaceGravity: 2,
    SurfaceTemperature: 180,
    SurfacePressure: 1000,
    Landable: true,
    TerraformState: "",
    WasDiscovered: true,
    WasMapped: false,
    WasFootfalled: false,
  });

const GENUS: Record<string, string> = { Stratum: "Stratum", Bacterial: "Bacterium" };

const bioSignals = (bodyId: number, genera: string[]): Event =>
  ev("SAASignalsFound", {
    BodyName: `${SYSTEM} ${bodyId}`,
    BodyID: bodyId,
    SystemAddress: ADDRESS,
    Signals: [
      {
        Type: "$SAA_SignalType_Biological;",
        Type_Localised: "Biological",
        Count: genera.length,
      },
    ],
    Genuses: genera.map((g) => ({
      Genus: `$Codex_Ent_${g}_Genus_Name;`,
      Genus_Localised: GENUS[g],
    })),
  });

const stratum = (bodyId: number, type: "Log" | "Sample" | "Analyse"): Event =>
  ev("ScanOrganic", {
    ScanType: type,
    Genus: "$Codex_Ent_Stratum_Genus_Name;",
    Genus_Localised: "Stratum",
    Species: "$Codex_Ent_Stratum_07_Name;",
    Species_Localised: "Stratum Tectonicas",
    SystemAddress: ADDRESS,
    Body: bodyId,
  });

/** ED Chat's panel feed on the temporary journal folder, polled as the app polls it. */
function game() {
  const pending: Event[] = [];
  // ed-mcp finds the newest journal by its name, read as UTC, so it is named from the first
  // event's time.
  const stamp = new Date(start).toISOString().slice(0, 19).replace(/:/g, "");
  const journal = path.join(dir, `Journal.${stamp}.01.log`);
  const errors: string[] = [];
  // One long-lived service, as the app opens it.
  const stores = openStores(
    { ED_JOURNAL_DIR: dir, ED_MCP_SYNC_DIR: syncDir },
    { keep: HUD_EVENTS },
  );
  // Without this, an ed-mcp error would show only as an empty panel.
  const feed = new HudFeed(stores, dir, { onError: (what, m) => errors.push(`${what}: ${m}`) });
  let polled = false;
  return {
    add: (...more: Event[]) => pending.push(...more),
    /** The ship on a body: latitude and longitude in degrees. */
    at: (bodyId: number, latitude: number, longitude: number) =>
      writeFile(
        path.join(dir, "Status.json"),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "Status",
          BodyName: `${SYSTEM} ${bodyId}`,
          Latitude: latitude,
          Longitude: longitude,
          PlanetRadius: RADIUS,
        }),
      ),
    /** The events the reader kept, after writing what was added. */
    async events() {
      await appendFile(
        journal,
        pending
          .splice(0)
          .map((e) => JSON.stringify(e) + "\n")
          .join(""),
      );
      const state = await stores.journal.state();
      expect((state as { warnings?: string[] }).warnings).toEqual([]);
      return state.events;
    },
    async hud(settings = DEFAULT_SETTINGS.hud): Promise<HudView> {
      // Appended, as the game writes it.
      await appendFile(
        journal,
        pending
          .splice(0)
          .map((e) => JSON.stringify(e) + "\n")
          .join(""),
      );
      // The journal service keeps its state for a second, so polls are a second apart, as the
      // app's are.
      if (polled) await new Promise((r) => setTimeout(r, 1_050));
      polled = true;
      const data = await feed.poll();
      expect(errors).toEqual([]);
      // ed-mcp reports a journal it could not read as a warning, with an empty state.
      expect((data.journal as { warnings?: string[] } | null)?.warnings).toEqual([]);
      return buildHud({ ...data, hotkey: null, settings, now: Date.now() }, null);
    },
  };
}

// Metres north on the test planet, in degrees of latitude.
const north = (m: number) => (m / RADIUS) * (180 / Math.PI);

describe("events the panel asks the reader to keep", () => {
  it("keeps every event the exploration totals and rate read", async () => {
    // A reader that stopped keeping one would quietly drop credits or time from the rates.
    const g = game();
    const body = { BodyName: `${SYSTEM} 3`, BodyID: 3, SystemAddress: ADDRESS, StarSystem: SYSTEM };
    const sample = { ...body, Body: `${SYSTEM} 3` };
    // arrive() writes Fileheader, Commander, LoadGame and FSDJump.
    g.add(
      ...arrive(),
      planet(3),
      ev("SAAScanComplete", body),
      ev("ApproachBody", sample),
      ev("Touchdown", { ...sample, Latitude: 1, Longitude: 2, PlayerControlled: true }),
      stratum(3, "Analyse"),
      ev("LeaveBody", sample),
      ev("Location", { StarSystem: SYSTEM, SystemAddress: ADDRESS, StarPos: [100, 0, 100] }),
      ev("CarrierJump", { StarSystem: SYSTEM, SystemAddress: ADDRESS, StarPos: [100, 0, 100] }),
      ev("SellExplorationData", { Systems: [SYSTEM], BaseValue: 1, Bonus: 0, TotalEarnings: 1 }),
      ev("MultiSellExplorationData", {
        Discovered: [{ SystemName: SYSTEM, NumBodies: 1 }],
        BaseValue: 1,
        Bonus: 0,
        TotalEarnings: 1,
      }),
      ev("SellOrganicData", { MarketID: 1, BioData: [] }),
      ev("Died"),
      ev("Shutdown"),
    );
    const kept = new Set((await g.events()).map((e) => e.event));
    expect(EXPLORATION_EVENTS.filter((e) => !kept.has(e))).toEqual([]);
  });

  it("keeps every event the trade panel, its mode and auto-advance read", async () => {
    // A reader that stopped keeping one would lose a trade's profit or never mark a stop done.
    const g = game();
    g.add(
      ...arrive(),
      ev("Docked", { StationName: "Port", StarSystem: SYSTEM, MarketID: 7 }),
      ev("MarketBuy", { MarketID: 7, Type: "gold", Count: 1, BuyPrice: 1, TotalCost: 1 }),
      ev("MarketSell", { MarketID: 7, Type: "gold", Count: 1, SellPrice: 2, TotalSale: 2 }),
      ev("Undocked", { StationName: "Port" }),
      ev("CarrierJump", { StarSystem: SYSTEM, SystemAddress: ADDRESS, StarPos: [100, 0, 100] }),
      ev("Died"),
      ev("Shutdown"),
    );
    const kept = new Set((await g.events()).map((e) => e.event));
    expect(TRADE_EVENTS.filter((e) => !kept.has(e))).toEqual([]);
  });
});

describe("panel from the real ed-mcp journal reader", () => {
  it("shows the species being sampled, its value and the colony distance", async () => {
    const g = game();
    g.add(...arrive(), planet(3), bioSignals(3, ["Stratum", "Bacterial"]), stratum(3, "Log"));
    await g.at(3, 10, 20);
    // ED Chat starts here: samples taken before it started have no known position.
    let v = await g.hud();
    expect(v.panel!.rows.slice(0, 2)).toEqual([
      { text: "Stratum Tectonicas", right: "1/3  95.1M", tone: "accent" },
      { text: "Bacterium  likely Aurasus", right: "~5.0M", tone: "dim" },
    ]);

    g.add(stratum(3, "Sample"));
    v = await g.hud();
    expect(v.panel).toMatchObject({ mode: "exobiology", title: "EXOBIOLOGY", subtitle: "3" });
    // A body nobody has walked on pays five times the value. Stratum's colony range is 500 m.
    expect(v.panel!.rows.slice(0, 2)).toEqual([
      { text: "Stratum Tectonicas", right: "2/3  95.1M", tone: "accent" },
      { text: "  ↔ 0 m / 500 m", tone: "warn", bar: 0 },
    ]);
    // The likely species comes from ed-mcp's prediction for the planet's conditions.
    expect(v.panel!.rows[2]).toEqual({
      text: "Bacterium  likely Aurasus",
      right: "~5.0M",
      tone: "dim",
    });

    await g.at(3, 10 + north(600), 20);
    v = await g.hud();
    expect(v.panel!.rows[1]).toEqual({ text: "  ↔ 600 m / 500 m", tone: "good", bar: 1 });

    g.add(stratum(3, "Sample"), stratum(3, "Analyse"));
    v = await g.hud();
    expect(v.panel!.rows[0]).toEqual({
      text: "Stratum Tectonicas",
      right: "✓  95.1M",
      tone: "good",
    });
  });

  it("shows the system's planets in exploration mode", async () => {
    const g = game();
    g.add(...arrive(), planet(3), bioSignals(3, ["Stratum", "Bacterial"]));
    const v = await g.hud();
    // The genera are named from their sample keys, and the species are ed-mcp's predictions.
    expect(v.panel).toEqual({
      mode: "exploration",
      title: "EXPLORE",
      subtitle: SYSTEM,
      right: "1 scanned",
      rows: [
        {
          text: "3  2 bio",
          detail: "Stratum Paleas?, Bacterium Aurasus?",
          right: "500 ls  ~11.8M ×5",
        },
      ],
      // The rate joins the Session line after 5 minutes, which a slow run can reach.
      footer: [
        "Unsold: 500 cartographic",
        expect.stringMatching(/^Session: 1 jumps · 1 scanned · 0 mapped · 0 ★( · .+\/h)?$/),
      ],
    });
  });

  it("leaves an expired mission out beside a live one, as ed-mcp reports them", async () => {
    const g = game();
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
    const take = (id: number, giver: string, expiry: number, reward: number) =>
      ev("MissionAccepted", {
        Faction: giver,
        Name: "Mission_MassacreWing",
        LocalisedName: "Kill Pirates",
        TargetFaction: "Bad Guys",
        KillCount: 10,
        Expiry: iso(expiry),
        Reward: reward,
        MissionID: id,
      });
    g.add(...arrive());
    g.add(
      ev("Docked", { StationName: "Port", StarSystem: SYSTEM, SystemAddress: ADDRESS }),
      // Expires two seconds after it was taken, before the kills below, which it must not get;
      // the other runs for a day.
      take(103, "Giver One", start + 7_000, 30_000_000),
      take(104, "Giver Two", Date.now() + 86_400_000, 5_000_000),
      ev("Undocked", { StationName: "Port" }),
    );
    for (let i = 0; i < 2; i++)
      g.add(ev("Bounty", { VictimFaction: "Bad Guys", TotalReward: 100_000, Target: "x" }));
    const v = await g.hud();
    expect(v.panel).toMatchObject({ mode: "massacre", right: "8 left" });
    // Only the live mission: its 5.0M over its 8 kills left, and only its giver's bar.
    expect(v.panel!.rows[0]).toMatchObject({ text: "Bad Guys", right: "8 left · ⚠ 625k/kill" });
    expect(v.panel!.rows.slice(1).map((r) => r.text)).toEqual(["Giver Two"]);
    expect(v.panel!.footer[0]).toBe("Stack 5.0M");
    expect(v.panel!.footer[1]).toMatch(/· 1 expired$/);
  });

  it("drops a massacre stack whose missions all expired, so massacre mode ends", async () => {
    const g = game();
    g.add(...arrive());
    g.add(
      ev("Docked", { StationName: "Port", StarSystem: SYSTEM, SystemAddress: ADDRESS }),
      ev("MissionAccepted", {
        Faction: "Giver One",
        Name: "Mission_MassacreWing",
        LocalisedName: "Kill Pirates",
        TargetFaction: "Bad Guys",
        KillCount: 10,
        // A minute after it was taken, and before now.
        Expiry: new Date(start + 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
        Reward: 5_000_000,
        MissionID: 102,
      }),
      ev("Undocked", { StationName: "Port" }),
    );
    const v = await g.hud();
    // Nothing else is going on in this journal, so no panel at all.
    expect(v.mode).not.toBe("massacre");
    expect(v.panel).toBeNull();
  });

  it("counts massacre kills against the target faction", async () => {
    const g = game();
    g.add(...arrive());
    g.add(
      ev("Docked", { StationName: "Port", StarSystem: SYSTEM, SystemAddress: ADDRESS }),
      ev("MissionAccepted", {
        Faction: "Giver One",
        Name: "Mission_MassacreWing",
        LocalisedName: "Kill Pirates",
        TargetFaction: "Bad Guys",
        KillCount: 10,
        Expiry: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"),
        Reward: 5_000_000,
        MissionID: 101,
      }),
      ev("Undocked", { StationName: "Port" }),
    );
    for (let i = 0; i < 3; i++)
      g.add(ev("Bounty", { VictimFaction: "Bad Guys", TotalReward: 100_000, Target: "x" }));
    const v = await g.hud();
    expect(v.panel).toEqual({
      mode: "massacre",
      title: "MASSACRE",
      right: "7 left",
      // 5.0M over the 7 kills left is under the default 1.0M a kill.
      rows: [
        { text: "Bad Guys", right: "7 left · ⚠ 714k/kill", tone: "accent" },
        { text: "Giver One", right: "3/10", bar: 0.3 },
      ],
      // Read against the real clock, so a slow run can take a minute off.
      footer: ["Stack 5.0M", expect.stringMatching(/^next expires 23h 5\dm$/)],
    });
  });
});

describe("passengers from the real ed-mcp journal reader", () => {
  it("shows the run with the berths from the fitted cabins", async () => {
    const g = game();
    g.add(
      ...arrive(),
      ev("Loadout", {
        Ship: "python",
        Modules: [
          { Slot: "Slot01_Size6", Item: "int_passengercabin_size5_class1" },
          { Slot: "Slot02_Size5", Item: "int_passengercabin_size4_class2" },
        ],
      }),
      ev("MissionAccepted", {
        Faction: "Giver One",
        Name: "Mission_PassengerBulk",
        LocalisedName: "Take tourists",
        PassengerCount: 4,
        PassengerType: "Tourist",
        PassengerVIPs: false,
        PassengerWanted: false,
        DestinationSystem: "Ochosi",
        DestinationStation: "Perez Market",
        Expiry: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"),
        Reward: 1_000_000,
        MissionID: 201,
      }),
    );
    const v = await g.hud();
    expect(v.panel).toMatchObject({ mode: "passenger", title: "PASSENGERS" });
    expect(v.panel!.right).toMatch(/^4\/\d+ berths/);
    expect(v.panel!.rows[0]!.text).toBe("Ochosi · Perez Market");
  });

  it("keeps passengers redirected home aboard, and drops the mission once completed", async () => {
    const g = game();
    g.add(
      ...arrive(),
      ev("Docked", { StationName: "Port", StarSystem: SYSTEM, SystemAddress: ADDRESS }),
      ev("MissionAccepted", {
        Faction: "Giver One",
        Name: "Mission_Sightseeing",
        LocalisedName: "Show tourists the sights",
        PassengerCount: 4,
        PassengerType: "Tourist",
        DestinationSystem: "Ochosi",
        DestinationStation: "Perez Market",
        Expiry: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"),
        Reward: 1_000_000,
        MissionID: 203,
      }),
      ev("Undocked", { StationName: "Port" }),
      // The tour is done: ed-mcp marks it complete, to hand in back at the giver.
      ev("MissionRedirected", {
        MissionID: 203,
        NewDestinationSystem: SYSTEM,
        NewDestinationStation: "Port",
        OldDestinationSystem: "Ochosi",
        OldDestinationStation: "Perez Market",
      }),
    );
    let v = await g.hud();
    expect(v.panel).toMatchObject({ mode: "passenger", right: expect.stringMatching(/^4 berths/) });
    expect(v.panel!.rows[0]).toMatchObject({ text: `${SYSTEM} · Port`, tone: "dim" });
    expect(v.panel!.rows[0]!.right).toMatch(/^4 pax · hand in/);
    expect(v.panel!.footer).toEqual(["1 mission · 1 to hand in"]);

    // Handed in: ed-mcp drops the mission, and the run is over.
    g.add(ev("MissionCompleted", { MissionID: 203, Faction: "Giver One", Reward: 1_000_000 }));
    v = await g.hud();
    // Nothing else is going on in this journal, so the panel is empty.
    expect(v.panel).toBeNull();
  });

  it("names a delivery's goods as the game does, not by their journal symbol", async () => {
    const g = game();
    g.add(
      ...arrive(),
      ev("MissionAccepted", {
        Faction: "Giver One",
        Name: "Mission_Delivery",
        LocalisedName: "Deliver gold",
        Commodity: "$Gold_Name;",
        Commodity_Localised: "Gold",
        Count: 10,
        DestinationSystem: "Wolf 397",
        DestinationStation: "Brooks Estate",
        Expiry: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"),
        Reward: 500_000,
        MissionID: 202,
      }),
    );
    const v = await g.hud();
    expect(v.panel).toMatchObject({ mode: "passenger", title: "DELIVERIES" });
    expect(v.panel!.rows[0]).toMatchObject({ text: "Wolf 397 · Brooks Estate" });
    expect(v.panel!.rows[0]!.right).toMatch(/^10 t Gold/);
  });
});

describe("mining from the real ed-mcp journal reader", () => {
  // The mining rules read Docked, Location, LoadGame, Died, FSDJump, CarrierJump and Cargo, all in
  // HUD_EVENTS: this runs them through ed-mcp's real reader, so a test fails if one stops arriving.
  const RING = `${SYSTEM} 2 A Ring`;
  const cargo = (platinum: number): Event =>
    ev("Cargo", {
      Vessel: "Ship",
      Count: platinum + 10,
      Inventory: [
        { Name: "drones", Name_Localised: "Limpet", Count: 10, Stolen: 0 },
        ...(platinum ? [{ Name: "platinum", Count: platinum, Stolen: 0 }] : []),
      ],
    });

  it("shows the rock and hotspots, keeps the ring at a carrier, and ends after selling", async () => {
    const g = game();
    g.add(
      ...arrive(),
      ev("SupercruiseExit", { StarSystem: SYSTEM, Body: RING, BodyType: "PlanetaryRing" }),
      ev("SAASignalsFound", {
        BodyName: RING,
        SystemAddress: ADDRESS,
        BodyID: 9,
        Signals: [{ Type: "Platinum", Count: 2 }],
      }),
      ev("ProspectedAsteroid", {
        Materials: [{ Name: "Platinum", Proportion: 31.4 }],
        Content: "$AsteroidMaterialContent_High;",
        Remaining: 100,
      }),
      ev("MiningRefined", { Type: "$platinum_name;", Type_Localised: "Platinum" }),
      cargo(1),
    );
    let v = await g.hud();
    expect(v.panel).toMatchObject({ mode: "mining", title: "MINING", subtitle: "2 A Ring" });
    expect(v.panel!.rows[0]).toMatchObject({ text: "Platinum 31.4% · High", right: "MINE" });
    expect(v.panel!.rows.some((r) => r.text === "Hotspots: Platinum ×2")).toBe(true);
    // The reader's cargo reaches the hold row; the refined ton comes from MiningRefined.
    expect(v.panel!.rows.find((r) => r.text.startsWith("Hold"))).toMatchObject({
      text: "Hold 11 t",
      right: expect.stringContaining("10 limpets"),
    });
    expect(v.panel!.footer.at(-1)).toMatch(/· 1 t refined$/);

    // Docking at a carrier beside the ring keeps the ring (Docked must be kept).
    g.add(
      ev("Docked", {
        StationName: "XFZ-12K",
        StationType: "FleetCarrier",
        StarSystem: SYSTEM,
        MarketID: 9,
      }),
    );
    v = await g.hud();
    expect(v.panel!.subtitle).toBe("2 A Ring");

    // A jump ends mining unless mined cargo is aboard, so this checks that the reader's cargo (no
    // MissionID) counts as the ship's own mined platinum.
    g.add(
      ev("Undocked"),
      ev("FSDJump", { StarSystem: "Other", SystemAddress: 1, StarPos: [0, 0, 0] }),
    );
    v = await g.hud();
    expect(v.panel!.mode).toBe("mining");

    // Selling it ends mining.
    g.add(ev("MarketSell", { Type: "platinum", Count: 1 }), cargo(0));
    v = await g.hud();
    expect(v.panel?.mode).not.toBe("mining");
  });

  it("finds the carrier and the tons moved to it", async () => {
    const ID = 3_700_000_001;
    const g = game();
    g.add(
      ...arrive(),
      ev("CarrierLocation", { CarrierType: "FleetCarrier", CarrierID: ID, StarSystem: SYSTEM }),
      ev("CarrierStats", {
        CarrierID: ID,
        Callsign: "XFZ-12K",
        Name: "DISTANT HORIZONS",
        SpaceUsage: { FreeSpace: 10_000 },
      }),
      ev("SupercruiseExit", { StarSystem: SYSTEM, Body: RING, BodyType: "PlanetaryRing" }),
      ev("MiningRefined", { Type: "$platinum_name;", Type_Localised: "Platinum" }),
      ev("MiningRefined", { Type: "$platinum_name;", Type_Localised: "Platinum" }),
      cargo(2),
      ev("Docked", {
        StationName: "XFZ-12K",
        StationType: "FleetCarrier",
        StarSystem: SYSTEM,
        MarketID: ID,
      }),
      ev("CargoTransfer", {
        Transfers: [{ Type: "platinum", Count: 2, Direction: "tocarrier" }],
      }),
      cargo(0),
    );
    const hud = DEFAULT_SETTINGS.hud;
    const v = await g.hud({ ...hud, mining: { ...hud.mining, useCarrier: true } });
    expect(v.panel!.mode).toBe("mining");
    expect(v.panel!.rows.find((r) => r.text.startsWith("Carrier"))).toMatchObject({
      text: `Carrier XFZ-12K · ${SYSTEM}`,
      right: "2 t moved · 9,998 t free",
    });
  });
});

describe("trade from the real ed-mcp journal reader", () => {
  const gold = (count: number): Event =>
    ev("Cargo", {
      Vessel: "Ship",
      Count: count,
      Inventory: count ? [{ Name: "gold", Name_Localised: "Gold", Count: count, Stolen: 0 }] : [],
    });
  const market = (id: number, station: string, buy: number, sell: number) =>
    writeFile(
      path.join(dir, "Market.json"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "Market",
        MarketID: id,
        StationName: station,
        StarSystem: SYSTEM,
        Items: [{ Name: "$gold_name;", Name_Localised: "Gold", BuyPrice: buy, SellPrice: sell }],
      }),
    );

  it("follows a saved trade loop: buys, a jump, a sale, and each stop marked done", async () => {
    // The plan as ed-mcp's trade_loops saves it, and the note it points at the plan.
    const stores = openStores({ ED_JOURNAL_DIR: dir, ED_MCP_SYNC_DIR: syncDir });
    await stores.plans.upsert({
      id: "trade",
      name: `Trade loop: ${SYSTEM} ⇄ Wolf 397`,
      repeat: true,
      lap: 1,
      stops: [
        {
          system: SYSTEM,
          station: "Port",
          purpose: "Sell 10 t Silver, then buy 10 t Gold",
          label: "Sell 10 t Silver, then buy 10 t Gold at Port",
          kind: "trade",
          cargo: [
            { commodity: "Silver", action: "sell", amount: 10, price: 4_000 },
            { commodity: "Gold", action: "buy", amount: 10, price: 9_380 },
          ],
        },
        {
          system: "Wolf 397",
          station: "Brooks Estate",
          purpose: "Sell 10 t Gold, then buy 10 t Silver",
          label: "Sell 10 t Gold, then buy 10 t Silver at Brooks Estate",
          kind: "trade",
          cargo: [
            { commodity: "Gold", action: "sell", amount: 10, price: 30_000 },
            { commodity: "Silver", action: "buy", amount: 10, price: 3_000 },
          ],
        },
      ],
    });
    await stores.activity.set({ kind: "trading", summary: "Trade loop", plan_id: "trade" });

    const g = game();
    g.add(...arrive(), ev("Docked", { StationName: "Port", StarSystem: SYSTEM, MarketID: 7 }));
    await market(7, "Port", 9_410, 9_000);
    let v = await g.hud();
    expect(v.panel).toMatchObject({
      mode: "trade",
      title: "TRADE",
      subtitle: `Loop: ${SYSTEM} ⇄ Wolf 397`,
      right: "lap 1",
    });
    // The first lap has nothing to sell at the first stop: only its buy.
    expect(v.panel!.rows).toEqual([
      { text: `● ${SYSTEM} · Port`, right: "BUY 10 t Gold" },
      { text: "  hold 0/10 · price 9,410 (plan 9,380)" },
      {
        text: "▸ Wolf 397 · Brooks Estate",
        right: "SELL 10 t Gold · BUY 10 t Silver",
        tone: "dim",
      },
    ]);

    // Bought: the hold has the planned tons, so the stop is done.
    g.add(
      ev("MarketBuy", {
        MarketID: 7,
        Type: "gold",
        Type_Localised: "Gold",
        Count: 10,
        BuyPrice: 9_410,
        TotalCost: 94_100,
      }),
      gold(10),
    );
    v = await g.hud();
    expect(v.panel!.rows[1]).toEqual({
      text: "  hold 10/10 · price 9,410 (plan 9,380)",
      tone: "good",
    });
    // What ED Chat's main process judges after each poll.
    const judge = async () => {
      // Fresh stores: the journal service keeps its state for a second.
      const fresh = openStores(
        { ED_JOURNAL_DIR: dir, ED_MCP_SYNC_DIR: syncDir },
        { keep: HUD_EVENTS },
      );
      const data = await new HudFeed(fresh, dir).poll();
      return tradeAdvance({
        plan: data.plan,
        events: data.journal!.events,
        cargo: data.journal!.cargo,
        capacity: data.journal!.ship.cargo_capacity,
        location: data.journal!.location,
      });
    };
    expect((await judge())?.index).toBe(0);
    // As ED Chat's main process marks it.
    await stores.plans.updateStop("trade", { index: 0 }, { status: "done" });

    // Undocking before selling leaves the next stop open.
    g.add(
      ev("Undocked", { StationName: "Port" }),
      ev("FSDJump", { StarSystem: "Wolf 397", SystemAddress: 397, StarPos: [10, 0, 10] }),
      ev("Docked", { StationName: "Brooks Estate", StarSystem: "Wolf 397", MarketID: 8 }),
      ev("MarketSell", {
        MarketID: 8,
        Type: "gold",
        Type_Localised: "Gold",
        Count: 10,
        SellPrice: 30_000,
        TotalSale: 300_000,
        AvgPricePaid: 9_410,
      }),
      gold(0),
    );
    v = await g.hud();
    expect(v.panel!.rows.slice(0, 3)).toEqual([
      { text: "● Wolf 397 · Brooks Estate" },
      { text: "  SELL 10 t Gold", right: "hold 0/10 · plan 30,000", tone: "good" },
      { text: "  BUY 10 t Silver", right: "hold 0/10 · plan 3,000" },
    ]);
    // 10 t sold at 30,000 that cost 9,410, a few minutes ago.
    expect(v.panel!.footer).toEqual([expect.stringMatching(/^Session: 206k profit · \d+m$/)]);
    // The silver is not bought yet, so the stop stays open.
    expect(await judge()).toBeNull();

    // Bought: the last stop is done, and ed-mcp starts the next lap.
    g.add(
      ev("MarketBuy", {
        MarketID: 8,
        Type: "silver",
        Type_Localised: "Silver",
        Count: 10,
        BuyPrice: 3_000,
        TotalCost: 30_000,
      }),
      ev("Cargo", {
        Vessel: "Ship",
        Count: 10,
        Inventory: [{ Name: "silver", Name_Localised: "Silver", Count: 10, Stolen: 0 }],
      }),
    );
    await g.hud();
    expect((await judge())?.index).toBe(1);
    await stores.plans.updateStop("trade", { index: 1 }, { status: "done" });
    v = await g.hud();
    // Then the rate, once the run is five minutes old on the real clock.
    expect(v.panel!.right).toMatch(/^lap 2( · [\d.]+[kM]\/h)?$/);
    // On the second lap the first stop sells what the last one bought.
    expect(v.panel!.rows[0]).toEqual({ text: `● ${SYSTEM} · Port` });
    expect(v.panel!.rows[1]).toMatchObject({
      text: "  SELL 10 t Silver",
      right: "hold 10/10 · plan 4,000",
    });
  });
});
