import { describe, expect, it } from "vitest";
import type { Exploration } from "ed-mcp/journal";
import {
  KnownBodies,
  isHighlight,
  parseSpanshDump,
  type KnownBody,
} from "../src/core/hud/known.js";
import { bioRows, explorationPanel, highlightRows } from "../src/core/hud/panels.js";

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
      { type: "Planet", name: "Sys 4", bodyId: 4, subType: "Water world", distanceToArrival: 40 },
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
      { text: "4  Water world", right: "40 ls  not scanned", tone: "dim" },
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
    const rows = bioRows({ system: "Sys", exploration: null, bio: [], known, bioMin: 5_000_000 });
    expect(rows).toEqual([
      {
        text: "5  2 bio · Clypeus, Bacterium",
        right: "300 ls  9.4M–24.6M  not scanned",
        tone: "dim",
      },
      { text: "7  3 bio", right: "20 ls  ?  not scanned", tone: "dim" },
    ]);
    // Fungoida alone is worth at most 3.7M, so it shows only with a lower threshold.
    expect(bioRows({ system: "Sys", exploration: null, bio: [], known, bioMin: 0 })).toHaveLength(
      3,
    );
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
    expect(panel([]).rows[0]!.text).toMatch(/Not on Spansh/);
    expect(panel(null).rows[0]!.text).not.toMatch(/Not on Spansh/);
  });
});
