import { describe, expect, it } from "vitest";
import type { Exploration } from "ed-mcp/journal";
import { KnownBodies, isHighlight, parseSpanshDump } from "../src/core/hud/known.js";
import { highlightRows } from "../src/core/hud/panels.js";

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
