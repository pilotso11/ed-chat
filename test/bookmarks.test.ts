import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PlanStore,
  type JournalEvent,
  type JournalState,
  type Plan,
  type Stop,
} from "ed-mcp/journal";
import {
  BOOKMARKS_PLAN,
  bearing,
  bookmarkRef,
  bookmarkHere,
  bookmarkLabel,
  bookmarkRows,
  finishedBioBookmarks,
  isPlanNotFound,
  newBookmark,
  sameBookmark,
  stopPosition,
  turn,
} from "../src/core/hud/bookmarks.js";
import { buildHud, parseShipStatus, type HudInput } from "../src/core/hud/hud.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const RADIUS = 1_556_918;
const SYSTEM = "Wredguia MN-J d9-9";
const BODY = `${SYSTEM} 6 k`;

type TestStop = Partial<Stop>;
const plan = (stops: TestStop[]): Plan =>
  ({
    id: "bookmarks",
    name: "Bookmarks",
    items: [],
    stops: stops.map((s) => ({ system: SYSTEM, purpose: "x", status: "todo", ...s })),
    created_at: "",
    updated_at: "",
  }) as Plan;

const status = (o: Partial<ReturnType<typeof parseShipStatus> & object> = {}) => ({
  body: BODY,
  latitude: 54.142864,
  longitude: -51.743507,
  radius: RADIUS,
  heading: 226,
  ...o,
});

describe("bookmark geometry", () => {
  it("gives the bearing from one point to another", () => {
    expect(bearing({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBe(0);
    expect(bearing({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBe(90);
    expect(bearing({ latitude: 0, longitude: 0 }, { latitude: -1, longitude: 0 })).toBe(180);
    expect(bearing({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: -1 })).toBe(270);
  });

  it("says which way to turn", () => {
    expect(turn(0, 5)).toBe("ahead");
    expect(turn(350, 20)).toBe("turn right 30°");
    expect(turn(90, 0)).toBe("turn left 90°");
  });

  it("reads the position field", () => {
    const stop = (position?: unknown) =>
      ({ system: "S", purpose: "x", status: "todo", position }) as never;
    expect(stopPosition(stop({ latitude: 1, longitude: 2 }))).toEqual({
      latitude: 1,
      longitude: 2,
    });
    expect(stopPosition(stop())).toBeNull();
  });
});

describe("making a bookmark", () => {
  it("labels it with the biology still to sample, else a number", () => {
    const bio = {
      species: [
        { species: "Stratum Tectonicas", analysed: true },
        { species: "Bacterium Cerbrus", analysed: false },
      ],
      not_started: ["Fungoida"],
      genera: ["Stratum", "Bacterium", "Fungoida"],
      bio_signals: 3,
    } as never;
    expect(bookmarkLabel(bio, [])).toEqual({
      label: "Bio: Bacterium Cerbrus, Fungoida",
      bio: true,
    });
    // Unique in the plan: a taken bio label gets a number, and numbers skip past the highest.
    expect(bookmarkLabel(bio, ["Bio: Bacterium Cerbrus, Fungoida"]).label).toBe(
      "Bio: Bacterium Cerbrus, Fungoida (2)",
    );
    expect(bookmarkLabel(null, ["Bookmark 1", "Bookmark 3"])).toEqual({
      label: "Bookmark 4",
      bio: false,
    });
  });

  it("makes a stop with the body and position", () => {
    const b = newBookmark({
      system: SYSTEM,
      body: BODY,
      here: { latitude: 54.142864, longitude: -51.743507 },
      label: "Bio: Concha",
      bio: true,
    });
    expect(b).toMatchObject({
      kind: "exobiology",
      body: BODY,
      status: "todo",
      position: { latitude: 54.142864, longitude: -51.743507 },
    });
  });

  it("needs a position on a planet", () => {
    const journal = {
      location: { system: SYSTEM },
      events: [] as JournalEvent[],
    } as unknown as JournalState & { events: JournalEvent[] };
    expect(bookmarkHere(journal, null, [])).toEqual({
      reason: "no position: be on or near a planet",
    });
    const made = bookmarkHere(journal, status(), []);
    expect("stop" in made && made.stop.purpose).toBe("Bookmark 1");
  });
});

describe("bookmark rows", () => {
  it("guides to bookmarks on this body, and counts those on others", () => {
    const rows = bookmarkRows({
      plan: plan([
        { body: BODY, label: "Bio: Concha", position: { latitude: 54.16, longitude: -51.74 } },
        { body: BODY, label: "Landing", position: { latitude: 54.14287, longitude: -51.7435 } },
        { body: `${SYSTEM} 5`, position: { latitude: 1, longitude: 1 } },
        { body: BODY, label: "Done one", position: { latitude: 0, longitude: 0 }, status: "done" },
        { system: "Elsewhere", body: "Elsewhere 1", position: { latitude: 1, longitude: 1 } },
      ]),
      system: SYSTEM,
      status: status(),
    });
    expect(rows).toEqual([
      // Nearest first.
      { text: "📍 Landing", right: "0 m · here · 34° · turn right 168°", tone: "good" },
      { text: "📍 Bio: Concha", right: "469 m · 7° · turn right 141°", tone: "accent" },
      { text: "📍 1 bookmark on 5", tone: "dim" },
    ]);
  });

  it("shows nothing outside the bookmarks' systems", () => {
    expect(bookmarkRows({ plan: plan([{ body: BODY }]), system: "Sol", status: status() })).toEqual(
      [],
    );
    expect(bookmarkRows({ plan: null, system: SYSTEM, status: status() })).toEqual([]);
  });

  it("reads the heading from Status.json", () => {
    expect(parseShipStatus('{"Heading":226,"BodyName":"X"}')?.heading).toBe(226);
  });

  it("shows on their own when no other panel shows", () => {
    const input: HudInput = {
      journal: {
        location: { system: SYSTEM, station: null, station_type: null, docked: false },
        ship: { type: null, cargo_capacity: null },
        cargo: [],
        missions: [],
        events: [],
      } as unknown as HudInput["journal"],
      status: status(),
      nav: null,
      activity: null,
      plan: null,
      hotkey: null,
      samples: new Map(),
      known: null,
      settings: DEFAULT_SETTINGS.hud,
      now: Date.UTC(2026, 10, 22),
      bookmarks: plan([
        { body: BODY, label: "Spot", position: { latitude: 54.16, longitude: -51.74 } },
      ]),
    };
    const v = buildHud(input, null);
    expect(v.panel?.title).toBe("BOOKMARKS");
    expect(v.panel?.rows[0]?.text).toBe("📍 Spot");

    // Under the exploration panel, after its own rows; not under mining.
    const at = Date.UTC(2026, 10, 22);
    const jumped = {
      ...input,
      journal: {
        ...input.journal!,
        events: [
          {
            timestamp: "2026-11-21T23:00:00Z",
            event: "FSDJump",
            StarSystem: SYSTEM,
            SystemAddress: 7,
          },
        ] as unknown as JournalEvent[],
      },
    };
    const explore = buildHud({ ...jumped, hotkey: { mode: "exploration", at } }, null);
    expect(explore.panel?.mode).toBe("exploration");
    expect(explore.panel?.rows.at(-1)?.text).toBe("📍 Spot");
    const mining = buildHud({ ...input, hotkey: { mode: "mining", at } }, null);
    expect(mining.panel?.mode).toBe("mining");
    expect(mining.panel?.rows.some((r) => r.text.startsWith("📍"))).toBe(false);
    // Nor on their own in massacre mode with no stack to show.
    expect(buildHud({ ...input, hotkey: { mode: "massacre", at } }, null).panel).toBeNull();
  });
});

describe("bookmark review fixes", () => {
  it("knows a body by its short name too, as Claude may write it", () => {
    const rows = bookmarkRows({
      plan: plan([
        { body: "6 k", label: "Short", position: { latitude: 54.16, longitude: -51.74 } },
        { body: "5 A", position: { latitude: 1, longitude: 1 } },
        { body: `${SYSTEM} 5 a`, position: { latitude: 1, longitude: 1 } },
      ]),
      system: SYSTEM,
      status: status(),
    });
    expect(rows).toEqual([
      { text: "📍 Short", right: "469 m · 7° · turn right 141°", tone: "accent" },
      { text: "📍 2 bookmarks on 5 A", tone: "dim" },
    ]);
  });

  it("shows bookmarks on this body without a distance when the radius is unknown", () => {
    const rows = bookmarkRows({
      plan: plan([{ body: BODY, label: "Spot", position: { latitude: 1, longitude: 1 } }]),
      system: SYSTEM,
      status: status({ radius: null }),
    });
    expect(rows).toEqual([{ text: "📍 Spot", right: "on this body", tone: "accent" }]);
  });

  it("shows the five nearest and counts the rest", () => {
    const stops = Array.from({ length: 7 }, (_, i) => ({
      body: BODY,
      label: `B${i}`,
      position: { latitude: 54.142864 + (7 - i) * 0.001, longitude: -51.743507 },
    }));
    const rows = bookmarkRows({ plan: plan(stops), system: SYSTEM, status: status() });
    expect(rows.map((r) => r.text)).toEqual([
      "📍 B6",
      "📍 B5",
      "📍 B4",
      "📍 B3",
      "📍 B2",
      "📍 +2 more here",
    ]);
  });

  it("knows ed-mcp's own error for a missing plan", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bookmarks-"));
    const store = new PlanStore(path.join(dir, "plans.json"));
    try {
      const err = await store.get(BOOKMARKS_PLAN).catch((e: unknown) => e);
      expect(isPlanNotFound(err)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tells a missing plan from a failed read", () => {
    expect(isPlanNotFound(new Error('Plan "bookmarks" not found'))).toBe(true);
    expect(isPlanNotFound(new Error("Plan file is locked by another process; try again"))).toBe(
      false,
    );
  });

  it("can be turned off", () => {
    const input = {
      journal: {
        location: { system: SYSTEM, station: null, station_type: null, docked: false },
        ship: { type: null, cargo_capacity: null },
        cargo: [],
        missions: [],
        events: [],
      },
      status: status(),
      nav: null,
      activity: null,
      plan: null,
      hotkey: null,
      samples: new Map(),
      known: null,
      settings: { ...DEFAULT_SETTINGS.hud, bookmarks: false },
      now: Date.UTC(2026, 10, 22),
      bookmarks: plan([{ body: BODY, label: "Spot", position: { latitude: 1, longitude: 1 } }]),
    } as unknown as HudInput;
    expect(buildHud(input, null).panel).toBeNull();
  });
});

describe("finished bio bookmarks", () => {
  it("marks a bio bookmark done once every species on its body is analysed", () => {
    const events = [
      { timestamp: "2026-11-22T00:00:00Z", event: "FSDJump", StarSystem: SYSTEM, SystemAddress: 7 },
      {
        timestamp: "2026-11-22T00:01:00Z",
        event: "SAASignalsFound",
        BodyName: BODY,
        SystemAddress: 7,
        BodyID: 30,
        Signals: [{ Type: "$SAA_SignalType_Biological;", Count: 1 }],
        Genuses: [{ Genus: "$Codex_Ent_Bacterial_Genus_Name;", Genus_Localised: "Bacterium" }],
      },
      {
        timestamp: "2026-11-22T00:02:00Z",
        event: "ScanOrganic",
        ScanType: "Analyse",
        Genus: "$Codex_Ent_Bacterial_Genus_Name;",
        Genus_Localised: "Bacterium",
        Species: "$Codex_Ent_Bacterial_04_Name;",
        Species_Localised: "Bacterium Cerbrus",
        SystemAddress: 7,
        Body: 30,
      },
    ] as unknown as JournalEvent[];
    const journal = { location: { system: SYSTEM }, events } as unknown as JournalState & {
      events: JournalEvent[];
    };
    const p = plan([
      { body: BODY, kind: "exobiology", label: "Bio: Bacterium Cerbrus" },
      { body: BODY, kind: "other", label: "Landing" },
      { body: `${SYSTEM} 5`, kind: "exobiology", label: "Other bio" },
    ]);
    expect(finishedBioBookmarks(p, journal)).toEqual([0]);
    expect(finishedBioBookmarks(null, journal)).toEqual([]);
    // With no signal count the body may hold more: left to do.
    const noCount = events.map((e) =>
      e.event === "SAASignalsFound" ? { ...e, Signals: [] } : e,
    ) as JournalEvent[];
    expect(finishedBioBookmarks(p, { ...journal, events: noCount })).toEqual([]);
    // A count of 0 from a later scan with no biology listed is no count either.
    const zero = events.map((e) =>
      e.event === "SAASignalsFound"
        ? { ...e, Signals: [{ Type: "$SAA_SignalType_Geological;", Count: 2 }] }
        : e,
    ) as JournalEvent[];
    expect(finishedBioBookmarks(p, { ...journal, events: zero })).toEqual([]);
  });
});

describe("bookmark labels and finishing, more", () => {
  it("leaves out abandoned species and names signals with no genus yet", () => {
    const bio = {
      species: [{ species: "Bacterium Cerbrus", analysed: false, abandoned: true }],
      not_started: ["Bacterium"],
      genera: ["Bacterium"],
      bio_signals: 3,
    } as never;
    expect(bookmarkLabel(bio, []).label).toBe("Bio: Bacterium, 2 signals");
    const unscanned = { species: [], not_started: [], genera: [], bio_signals: 4 } as never;
    expect(bookmarkLabel(unscanned, [])).toEqual({ label: "Bio: 4 signals", bio: true });
  });

  it("matches a bookmark by what it is", () => {
    const a = {
      system: "S",
      body: "B",
      purpose: "x",
      status: "todo",
      position: { latitude: 1, longitude: 2 },
    };
    expect(sameBookmark(a as never, { ...a, status: "done" } as never)).toBe(true);
    expect(
      sameBookmark(a as never, { ...a, position: { latitude: 1, longitude: 3 } } as never),
    ).toBe(false);
  });
});

describe("marking a bookmark done", () => {
  const spot = { latitude: 1, longitude: 2 };
  it("names it by a label no other stop has, ignoring case", () => {
    const p = plan([{ body: BODY, label: "Bio: Concha", position: spot }]);
    expect(bookmarkRef(p, p.stops[0]!)).toEqual({ label: "Bio: Concha" });
  });

  it("uses the index when another stop has the same label", () => {
    const p = plan([
      { body: BODY, label: "Spot", position: { latitude: 9, longitude: 9 } },
      { body: BODY, label: "spot", position: spot },
    ]);
    expect(bookmarkRef(p, p.stops[1]!)).toEqual({ index: 1 });
  });

  it("finds it again after an edit moved it, and skips one that is gone or done", () => {
    const stop = plan([{ body: BODY, label: "Spot", position: spot }]).stops[0]!;
    const moved = plan([
      { body: BODY, label: "Other" },
      { body: BODY, label: "Spot", position: spot },
    ]);
    expect(bookmarkRef(moved, stop)).toEqual({ label: "Spot" });
    expect(bookmarkRef(plan([]), stop)).toBeNull();
    const done = plan([{ body: BODY, label: "Spot", position: spot, status: "done" }]);
    expect(bookmarkRef(done, stop)).toBeNull();
  });
});
