import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStores } from "ed-mcp/journal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HudFeed } from "../src/core/hud/feed.js";
import { buildHud, type HudView } from "../src/core/hud/hud.js";
import { HUD_EVENTS } from "../src/core/hud/mode.js";
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
      footer: ["Unsold: 500 cartographic", "Session: 1 jumps · 1 scanned · 0 mapped · 0 ★"],
    });
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
      rows: [
        { text: "Bad Guys", right: "7 left", tone: "accent" },
        { text: "Giver One", right: "3/10", bar: 0.3 },
      ],
      // Read against the real clock, so a slow run can take a minute off.
      footer: [expect.stringMatching(/^next expires 23h 5\dm$/)],
    });
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
    expect(v.panel!.rows.some((r) => r.text === "Refined: Platinum 1 t")).toBe(true);

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
