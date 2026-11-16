import { describe, expect, it } from "vitest";
import type { Exploration } from "ed-mcp/journal";
import {
  KnownBodies,
  isHighlight,
  parseSpanshDump,
  type KnownBody,
} from "../src/core/hud/known.js";
import { bioRows, explorationPanel, highlightRows, wasFootfalled } from "../src/core/hud/panels.js";

const dump = {
  system: {
    bodies: [
      { type: "Star", name: "Sys A", bodyId: 0, subType: "K (Yellow-Orange) Star" },
      {
        type: "Planet",
        name: "Sys 1",
        bodyId: 1,
        subType: "Earth-like world",
        distanceToArrival: 500,
        terraformingState: "Not terraformable",
      },
      {
        type: "Planet",
        name: "Sys 2",
        bodyId: 2,
        subType: "High metal content world",
        distanceToArrival: 90,
        terraformingState: "Terraformable",
      },
      { type: "Planet", name: "Sys 3", bodyId: 3, subType: "Icy body", distanceToArrival: 900 },
      {
        type: "Planet",
        name: "Sys 4",
        bodyId: 4,
        subType: "Water world",
        distanceToArrival: 40,
        earthMasses: 0.5,
      },
    ],
  },
};

describe("Spansh bodies", () => {
  it("reads the planets in the journal's spelling", () => {
    const b = parseSpanshDump(dump);
    expect(b.map((x) => x.type)).toEqual([
      "Earthlike body",
      "High metal content body",
      "Icy body",
      "Water world",
    ]);
    expect(b[1]!.terraformable).toBe(true);
    expect(b.filter((x) => isHighlight(x.type, x.terraformable)).map((x) => x.bodyId)).toEqual([
      1, 2, 4,
    ]);
    expect(parseSpanshDump({})).toEqual([]);
  });

  it("fetches each system once and keeps the result", async () => {
    const urls: string[] = [];
    const k = new KnownBodies(async (u) => (urls.push(u), dump));
    expect(k.get(42)).toBeNull();
    expect(k.get(42)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(k.get(42)).toHaveLength(4);
    expect(urls).toEqual(["https://spansh.co.uk/api/dump/42"]);
  });

  it("waits before asking again after a failure", async () => {
    let now = 0;
    let calls = 0;
    const k = new KnownBodies(async () => (calls++, Promise.reject(new Error("down"))), {
      now: () => now,
    });
    k.get(1);
    await new Promise((r) => setTimeout(r, 0));
    k.get(1);
    expect(calls).toBe(1);
    now = 6 * 60_000;
    k.get(1);
    expect(calls).toBe(2);
  });
});

describe("highlight rows", () => {
  it("lists the worlds nearest first: green when scanned, grey before", () => {
    const x = {
      discovery: { body_count: 5, non_body_count: 0, progress: 1, all_bodies_found: true },
      scanned: 1,
      bodies: [
        {
          body: "Sys 1",
          body_id: 1,
          type: "Earthlike body",
          distance_ls: 500,
          landable: false,
          terraformable: false,
          atmosphere: null,
          rings: [],
          was_discovered: true,
          was_mapped: true,
          mapped_by_you: false,
          signals: [],
          value_scanned: 283629,
          value_mapped: 1_000_000,
        },
      ],
    } as Exploration;
    expect(highlightRows("Sys", x, parseSpanshDump(dump))).toEqual([
      // Before the scan, from no bonus to first discovered and first mapped.
      { text: "4  Water world", right: "40 ls  ~524k–1.5M  not scanned", tone: "dim" },
      { text: "2  HMC tf", right: "90 ls  not scanned", tone: "dim" },
      { text: "1  Earth-like", right: "500 ls  1.0M  map", tone: "good" },
    ]);
  });
});

describe("bio rows", () => {
  const known = parseSpanshDump({
    bodies: [
      {
        type: "Planet",
        name: "Sys 5",
        bodyId: 5,
        distanceToArrival: 300,
        signals: {
          signals: { "$SAA_SignalType_Biological;": 2 },
          genuses: ["$Codex_Ent_Clypeus_Genus_Name;", "$Codex_Ent_Bacterial_Genus_Name;"],
        },
      },
      {
        type: "Planet",
        name: "Sys 6",
        bodyId: 6,
        distanceToArrival: 10,
        signals: {
          signals: { "$SAA_SignalType_Biological;": 1 },
          genuses: ["$Codex_Ent_Fungoids_Genus_Name;"],
        },
      },
      {
        type: "Planet",
        name: "Sys 7",
        bodyId: 7,
        distanceToArrival: 20,
        signals: { signals: { "$SAA_SignalType_Biological;": 3 } },
      },
    ],
  });

  it("lists planets worth at least the threshold by their genera, and unknown ones", () => {
    const rows = bioRows({
      system: "Sys",
      address: null,
      events: [],
      exploration: null,
      bio: [],
      known,
      bioMin: 5_000_000,
    });
    expect(rows).toEqual([
      {
        text: "5  2 bio",
        detail: "Clypeus, Bacterium",
        // Until the scan says whether anyone has landed, up to the first-footfall bonus.
        right: "300 ls  ~9.4–47.1M  not scanned",
        tone: "dim",
      },
      { text: "7  3 bio", right: "20 ls  ?  not scanned", tone: "dim" },
    ]);
    // Fungoida alone is worth at most 3.7M, so it shows only with a lower threshold.
    expect(
      bioRows({
        system: "Sys",
        address: null,
        events: [],
        exploration: null,
        bio: [],
        known,
        bioMin: 0,
      }),
    ).toHaveLength(3);
  });

  it("names the likely species from Spansh's planet conditions", () => {
    const stratum = parseSpanshDump({
      bodies: [
        { type: "Star", name: "Sys A", bodyId: 0, subType: "F (White) Star", mainStar: true },
        {
          type: "Planet",
          name: "Sys 8",
          bodyId: 8,
          subType: "High metal content world",
          atmosphereType: "Thin Sulphur dioxide",
          surfaceTemperature: 200,
          gravity: 0.3,
          surfacePressure: 0.01,
          volcanismType: "No volcanism",
          parents: [{ Star: 0 }],
          distanceToArrival: 50,
          signals: {
            signals: { "$SAA_SignalType_Biological;": 1 },
            genuses: ["$Codex_Ent_Stratum_Genus_Name;"],
          },
        },
      ],
    });
    expect(stratum[0]!.conditions).toMatchObject({
      atmosphere: "Thin Sulphur dioxide",
      star: "F (White) Star",
    });
    const rows = bioRows({
      system: "Sys",
      address: null,
      events: [],
      exploration: null,
      bio: [],
      known: stratum,
      bioMin: 5_000_000,
    });
    expect(rows).toEqual([
      {
        text: "8  1 bio",
        detail: "Stratum Tectonicas?",
        right: "50 ls  ~19.0–95.1M  not scanned",
        tone: "dim",
      },
    ]);
  });

  it("pays the first-footfall bonus once the scan says nobody has landed", () => {
    const scan = (WasFootfalled: boolean) => [
      {
        event: "Scan",
        timestamp: "2026-11-16T00:00:00Z",
        SystemAddress: 42,
        BodyID: 5,
        BodyName: "Sys 5",
        WasFootfalled,
      },
    ];
    const row = (events: ReturnType<typeof scan>) =>
      bioRows({
        system: "Sys",
        address: 42,
        events,
        exploration: null,
        bio: [],
        known,
        bioMin: 5_000_000,
      })[0]!.right;
    expect(row(scan(false))).toMatch(/~47.1M ×5/);
    expect(row(scan(true))).toMatch(/~9\.4M(?! ×5)/);
  });

  it("trusts a scan that says someone landed over a newer one that says not", () => {
    // Seen in a journal: an AutoScan on arrival, then the FSS's Detailed scan a minute later.
    const scan = (WasFootfalled: boolean) => ({
      event: "Scan",
      timestamp: "2026-11-16T00:00:00Z",
      SystemAddress: 42,
      BodyID: 5,
      WasFootfalled,
    });
    expect(wasFootfalled([scan(true), scan(false)], 42, 5)).toBe(true);
    expect(wasFootfalled([scan(false)], 42, 5)).toBe(false);
    expect(wasFootfalled([], 42, 5)).toBeNull();
  });

  it("is green only once every species is analysed", () => {
    const tone = (analysed: number) =>
      bioRows({
        system: "Sys",
        address: 42,
        events: [],
        exploration: {
          bodies: [{ body: "Sys 5", body_id: 5, distance_ls: 300, was_discovered: true }],
        } as unknown as Exploration,
        bio: [
          {
            body: "Sys 5",
            body_id: 5,
            bio_signals: 2,
            genera: ["Clypeus", "Bacterium"],
            species: [
              {
                genus: "Clypeus",
                species: "Clypeus Speculumi",
                analysed: analysed > 0,
                value: 16202800,
              },
              {
                genus: "Bacterium",
                species: "Bacterium Cerbrus",
                analysed: analysed > 1,
                value: 1689800,
              },
            ],
          },
        ] as never,
        known: null,
        bioMin: 0,
      })[0]!.tone;
    expect(tone(0)).toBeUndefined();
    expect(tone(1)).toBeUndefined();
    expect(tone(2)).toBe("good");
  });

  it("says when Spansh does not know the system", () => {
    const x = {
      discovery: {
        body_count: null,
        non_body_count: null,
        progress: null,
        all_bodies_found: false,
      },
      scanned: 0,
      bodies: [],
    } as Exploration;
    const totals = {
      unsoldCartographic: 0,
      unsoldBio: 0,
      unsoldBioCount: 0,
      session: { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 },
    };
    const panel = (k: KnownBody[] | null) =>
      explorationPanel({
        system: "Sys",
        exploration: x,
        bio: [],
        totals,
        valuableMin: 0,
        known: k,
      });
    expect(panel([]).rows[0]).toMatchObject({
      text: expect.stringMatching(/★ Not on Spansh/),
      tone: "accent",
    });
    expect(panel(null).rows[0]!.text).not.toMatch(/Not on Spansh/);
  });

  it("ranks bodies by value, and counts bodies as the game does", () => {
    const body = (id: number, type: string | null, value: number, geo = 0) => ({
      body: `Sys ${id}`,
      body_id: id,
      type,
      distance_ls: 100,
      terraformable: false,
      was_discovered: true,
      mapped_by_you: false,
      signals: geo ? [{ type: "$SAA_SignalType_Geological;", count: geo }] : [],
      value_scanned: value,
      value_mapped: value,
    });
    // From a journal: small HMC worlds worth about 60k, icy moons with geological signals worth
    // about 4k, and belt clusters, which the game does not count as bodies.
    const x = {
      discovery: { body_count: 3, all_bodies_found: true },
      scanned: 4,
      bodies: [
        body(1, "Icy body", 4_000, 2),
        body(2, "High metal content body", 64_588),
        body(3, "Icy body", 2_000),
        body(4, null, 0),
      ],
    } as unknown as Exploration;
    const p = explorationPanel({
      system: "Sys",
      exploration: x,
      bio: [],
      totals: {
        unsoldCartographic: 0,
        unsoldBio: 0,
        unsoldBioCount: 0,
        session: { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 },
      },
      valuableMin: 500_000,
      known: null,
    });
    expect(p.rows.map((r) => r.text)).toEqual(["2  HMC", "1  Icy · 2 geo"]);
    expect(p.right).toBe("3/3 bodies ✓");
  });

  it("lets the journal's scans decide over Spansh", () => {
    const star = (was_discovered: boolean) =>
      ({
        exploration: {
          discovery: { body_count: null, all_bodies_found: false },
          scanned: 1,
          bodies: [{ body: "Sys", body_id: 0, type: "K star", was_discovered, signals: [] }],
        } as unknown as Exploration,
      }).exploration;
    const totals = {
      unsoldCartographic: 0,
      unsoldBio: 0,
      unsoldBioCount: 0,
      session: { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 },
    };
    const panel = (x: Exploration) =>
      explorationPanel({
        system: "Sys",
        exploration: x,
        bio: [],
        totals,
        valuableMin: 0,
        known: [],
      });
    expect(panel(star(false)).rows[0]).toMatchObject({ text: "★ Undiscovered system" });
    expect(
      panel(star(true))
        .rows.map((r) => r.text)
        .join(),
    ).not.toMatch(/Spansh|Undiscovered/);
  });
});
