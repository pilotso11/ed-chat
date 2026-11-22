import { describe, expect, it } from "vitest";
import type { ExobiologyBody } from "ed-mcp/journal";
import { bioProgress, exobiologyPanel, sampleKey, type Point } from "../src/core/hud/panels.js";

const totals = {
  unsoldCartographic: 0,
  unsoldBio: 0,
  unsoldBioCount: 0,
  session: { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 },
  rate: { session: null, recent: null },
  planetRate: new Map(),
};

const species = (over: Partial<ExobiologyBody["species"][number]>) => ({
  genus: "Bacterium",
  species: "Bacterium Cerbrus",
  variant: null,
  samples: 1,
  stage: "1/3",
  analysed: false,
  value: 1_689_800,
  colony_m: 500,
  ...over,
});

const body: ExobiologyBody = {
  body: "Sys A 3",
  body_id: 3,
  bio_signals: 3,
  genera: ["Bacterium", "Stratum", "Fungoida"],
  species: [
    species({}),
    species({
      genus: "Stratum",
      species: "Stratum Tectonicas",
      analysed: true,
      stage: "3/3",
      value: 19_010_800,
    }),
  ],
  not_started: ["Fungoida"],
  likely: [
    {
      genus: "Fungoida",
      species: [
        { name: "Fungoida Bullarum", value: 3_703_200, likelihood: 0.6 },
        { name: "Fungoida Stabitis", value: 2_680_300, likelihood: 0.3 },
        { name: "Fungoida Gelata", value: 3_330_300, likelihood: 0.1 },
      ],
    },
  ],
};

// On a 1,000 km planet, 0.01° of latitude is about 175 m.
const RADIUS = 1_000_000;
const panel = (opts: {
  samples?: Map<string, Point[]>;
  here?: Point | null;
  footfall?: boolean | null;
  address?: number | null;
}) =>
  exobiologyPanel({
    system: "Sys",
    address: opts.address ?? 7,
    body,
    samples: opts.samples ?? new Map(),
    here: opts.here ? { ...opts.here, radius: RADIUS } : null,
    totals,
    footfall: opts.footfall,
  });

describe("exobiology panel", () => {
  it("shows the distance from the last sample against the colony range", () => {
    const samples = new Map([
      [sampleKey(7, 3, "Bacterium Cerbrus"), [{ latitude: 0, longitude: 0 }]],
    ]);
    const near = panel({ samples, here: { latitude: 0.01, longitude: 0 } }).rows[1]!;
    expect(near.text).toBe("  ↔ 175 m / 500 m");
    expect(near.tone).toBe("warn");
    expect(near.bar).toBeCloseTo(0.35, 2);
    const far = panel({ samples, here: { latitude: 0.04, longitude: 0 } }).rows[1]!;
    expect(far.tone).toBe("good");
    expect(far.bar).toBe(1);
  });

  it("ignores samples taken in another system", () => {
    const samples = new Map([
      [sampleKey(8, 3, "Bacterium Cerbrus"), [{ latitude: 0, longitude: 0 }]],
    ]);
    const rows = panel({ samples, here: { latitude: 0.01, longitude: 0 } }).rows;
    expect(rows.some((r) => r.text.includes("↔"))).toBe(false);
  });

  it("names the likely species of a genus not started", () => {
    const row = panel({}).rows.find((r) => r.text.startsWith("Fungoida"))!;
    expect(row).toEqual({
      text: "Fungoida  likely Bullarum / Stabitis",
      right: "~3.7M",
      tone: "dim",
    });
  });

  it("turns the header green with ✓ once every signal has a species analysed", () => {
    const analysed = (genus: string) =>
      species({ genus, species: `${genus} X`, analysed: true, stage: "3/3" });
    const done: ExobiologyBody = {
      ...body,
      species: [analysed("Bacterium"), analysed("Stratum"), analysed("Fungoida")],
      not_started: [],
    };
    const p = exobiologyPanel({
      system: "Sys",
      address: 7,
      body: done,
      samples: new Map(),
      here: null,
      totals,
    });
    expect(p.right).toBe("3/3 genera ✓");
    expect(p.tone).toBe("good");
    // An abandoned species does not count, and a body with no signal count uses its genera.
    const abandoned = {
      ...done,
      species: [...done.species.slice(0, 2), { ...done.species[2]!, abandoned: true as const }],
    };
    expect(bioProgress(abandoned)).toEqual({ analysed: 2, signals: 3, done: false });
    // With no signal count the body may hold more: never done, and the genera found are counted.
    expect(bioProgress({ ...done, bio_signals: null })).toEqual({
      analysed: 3,
      signals: 3,
      done: false,
    });
    expect(bioProgress({ ...done, bio_signals: null, genera: [], species: [] }).done).toBe(false);
    expect(bioProgress({ ...done, bio_signals: 0 })).toEqual({
      analysed: 3,
      signals: 3,
      done: false,
    });
    // Spansh's count stands in for a journal count of null or 0.
    expect(bioProgress({ ...done, bio_signals: 0 }, 3).done).toBe(true);
    expect(bioProgress({ ...done, bio_signals: null }, 4)).toEqual({
      analysed: 3,
      signals: 4,
      done: false,
    });
    const header = exobiologyPanel({
      system: "Sys",
      address: 7,
      body: { ...done, bio_signals: null },
      samples: new Map(),
      here: null,
      totals,
      knownSignals: 3,
    });
    expect(header.right).toBe("3/3 genera ✓");
    // Two species of one genus with no count: 2/2, not 2/1.
    expect(
      bioProgress({
        ...done,
        bio_signals: null,
        genera: ["Bacterium"],
        species: [done.species[0]!, done.species[1]!],
      }),
    ).toMatchObject({ analysed: 2, signals: 2 });
    // Two species of one genus analysed and a genus not started: 2/3, not done.
    expect(
      bioProgress({
        ...done,
        bio_signals: 2,
        genera: ["Bacterium", "Fungoida"],
        species: [done.species[0]!, done.species[1]!],
        not_started: ["Fungoida"],
      }),
    ).toEqual({ analysed: 2, signals: 3, done: false });
    // More genera found than signals counted: the genera are the total.
    expect(bioProgress({ ...done, bio_signals: 2 })).toEqual({
      analysed: 3,
      signals: 3,
      done: true,
    });
  });

  it("pays five times on a first footfall", () => {
    const p = panel({ footfall: false });
    expect(p.right).toBe("first footfall ×5 · 1/3 genera");
    expect(p.rows.find((r) => r.text === "Stratum Tectonicas")!.right).toBe("✓  95.1M");
    expect(p.rows[0]!.right).toBe("1/3  8.4M");
    expect(p.rows.find((r) => r.text.startsWith("Fungoida"))!.right).toBe("~18.5M");
    expect(panel({ footfall: true }).right).toBe("1/3 genera");
    expect(panel({ footfall: true }).tone).toBeUndefined();
  });

  it("asks for a restart when another species was started first", () => {
    const abandoned = { ...body, species: [species({ abandoned: true })] };
    const p = exobiologyPanel({
      system: "Sys",
      address: 7,
      body: abandoned,
      samples: new Map(),
      here: null,
      totals,
    });
    expect(p.rows[0]).toMatchObject({ text: "Bacterium Cerbrus", tone: "warn" });
    expect(p.rows[0]!.right).toMatch(/^restart/);
  });
});
