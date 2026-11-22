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
  BIO_NOTE,
  BOOKMARKS_PLAN,
  bearing,
  bioLeft,
  bookmarkRef,
  bookmarkHere,
  bookmarkLabel,
  bookmarkRows,
  bookmarksToClear,
  isKeyRepeat,
  keyClearStops,
  finishedBioBookmarks,
  isPlanNotFound,
  keepSavedBookmarks,
  newBookmark,
  sameBookmark,
  stopPosition,
  todoBookmarks,
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
      notes: BIO_NOTE,
    });
    // Only a bio bookmark carries the note that lets the panel redraw its label.
    const other = newBookmark({
      system: SYSTEM,
      body: BODY,
      here: { latitude: 0, longitude: 0 },
      label: "Bookmark 1",
      bio: false,
    });
    expect(other.notes).toBeUndefined();
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
    // Nor on their own in massacre mode with no stack to show, or passenger mode with no run.
    expect(buildHud({ ...input, hotkey: { mode: "massacre", at } }, null).panel).toBeNull();
    expect(buildHud({ ...input, hotkey: { mode: "passenger", at } }, null).panel).toBeNull();
    // On their own in route mode, and in exploration mode with no jump into this system in the
    // events, so no exploration panel.
    expect(buildHud({ ...input, hotkey: { mode: "route", at } }, null).panel?.title).toBe(
      "BOOKMARKS",
    );
    expect(buildHud({ ...input, hotkey: { mode: "exploration", at } }, null).panel?.title).toBe(
      "BOOKMARKS",
    );
    // Not under a passenger panel with a run to show.
    const run = buildHud(
      {
        ...input,
        journal: {
          ...input.journal!,
          missions: [
            {
              mission_id: 1,
              name: "Mission_Sightseeing",
              destination_system: "Shinrarta Dezhra",
              destination_station: "Jameson Memorial",
              passengers: 4,
            },
          ],
        } as unknown as HudInput["journal"],
        hotkey: { mode: "passenger", at },
      },
      null,
    );
    expect(run.panel?.mode).toBe("passenger");
    expect(run.panel?.rows.some((r) => r.text.startsWith("📍"))).toBe(false);
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
    // Spansh's count fills in the signals with no genus known yet; auto-done still waits for the journal's.
    expect(
      bioLeft({ genera: ["A"], bio_signals: null, species: [], not_started: [] } as never, 3),
    ).toEqual(["2 signals"]);
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

  it("uses the index for a bookmark with no label, and tells two in one spot by label", () => {
    const bare = plan([{ body: BODY, position: spot }]);
    expect(bookmarkRef(bare, bare.stops[0]!)).toEqual({ index: 0 });
    const twins = plan([
      { body: BODY, label: "A", position: spot },
      { body: BODY, label: "B", position: spot },
    ]);
    expect(bookmarkRef(twins, twins.stops[1]!)).toEqual({ label: "B" });
  });
});

describe("a bookmark saved during a poll", () => {
  const read = plan([]);
  const saved = { plan: plan([{ body: BODY, label: "Spot" }]), afterPoll: 3 };

  it("is kept over a poll that started before the save", () => {
    expect(keepSavedBookmarks({ bookmarks: read }, saved, 3)).toEqual({
      data: { bookmarks: saved.plan },
      saved,
    });
  });

  it("is dropped once a poll started after it, so later edits show", () => {
    expect(keepSavedBookmarks({ bookmarks: read }, saved, 4)).toEqual({
      data: { bookmarks: read },
      saved: null,
    });
    expect(keepSavedBookmarks({ bookmarks: read }, null, 1).data.bookmarks).toBe(read);
  });
});

describe("clearing bookmarks", () => {
  const near = { body: BODY, label: "Near", position: { latitude: 54.14287, longitude: -51.7435 } };
  const far = { body: BODY, label: "Far", position: { latitude: 54.16, longitude: -51.74 } };
  const other = { body: `${SYSTEM} 5`, label: "Other body" };
  const away = { system: "Elsewhere", body: "Elsewhere 1", label: "Away" };

  it("clears the nearest bookmark on this body", () => {
    const p = plan([far, other, near, away]);
    expect(bookmarksToClear({ plan: p, system: SYSTEM, status: status() })).toEqual({
      stops: [2],
      whole: false,
    });
  });

  it("clears the first on the body when positions are not known", () => {
    const p = plan([other, { body: BODY, label: "A" }, { body: BODY, label: "B" }]);
    expect(bookmarksToClear({ plan: p, system: SYSTEM, status: status() }).stops).toEqual([1]);
    const q = plan([far, near]);
    expect(
      bookmarksToClear({ plan: q, system: SYSTEM, status: status({ latitude: null }) }).stops,
    ).toEqual([0]);
  });

  it("clears every bookmark in the system away from a bookmarked body, as a whole system", () => {
    // A stop with no body is not shown, so it is not cleared either.
    const p = plan([far, other, away, { ...near, status: "done" }, { label: "No body" }]);
    const whole = { stops: [0, 1], whole: true };
    expect(
      bookmarksToClear({ plan: p, system: SYSTEM, status: status({ body: `${SYSTEM} 3` }) }),
    ).toEqual(whole);
    expect(bookmarksToClear({ plan: p, system: SYSTEM, status: null })).toEqual(whole);
  });

  it("lets the key clear one bookmark on the body, never a whole system", () => {
    expect(keyClearStops({ stops: [2], whole: false })).toEqual({ stops: [2] });
    const whole = keyClearStops({ stops: [0, 1], whole: true });
    expect(whole).not.toHaveProperty("stops");
    expect(whole).toEqual({ reason: expect.stringContaining("tray menu") });
  });

  it("takes a held key's repeats as one press", () => {
    // Windows' first repeat comes after up to a second, then every few tens of ms.
    expect(isKeyRepeat(1_000, 0)).toBe(true);
    expect(isKeyRepeat(1_033, 1_000)).toBe(true);
    expect(isKeyRepeat(5_000, 1_000)).toBe(false);
    expect(isKeyRepeat(1_000_000, 0)).toBe(false);
  });

  it("clears nothing in a system without bookmarks", () => {
    const none = { stops: [], whole: false };
    expect(bookmarksToClear({ plan: plan([far]), system: "Sol", status: status() })).toEqual(none);
    expect(bookmarksToClear({ plan: null, system: SYSTEM, status: status() })).toEqual(none);
    expect(bookmarksToClear({ plan: plan([far]), system: null, status: status() })).toEqual(none);
  });

  it("lists every bookmark still to do", () => {
    expect(
      todoBookmarks(plan([far, { ...near, status: "skipped" }, away, { label: "x" }])),
    ).toEqual([0, 2]);
    expect(todoBookmarks(null)).toEqual([]);
  });
});

describe("bio bookmark rows", () => {
  const bio = (o: object) =>
    ({
      body: BODY,
      body_id: 6,
      species: [],
      not_started: [],
      genera: [],
      bio_signals: null,
      likely: [],
      ...o,
    }) as never;
  const mark = {
    body: BODY,
    kind: "exobiology" as const,
    label: "Bio: Frutexa Acus, Bacterium, Concha, Tussock",
    notes: BIO_NOTE,
  };
  const rows = (b: unknown[], stops: TestStop[] = [mark], s = status({ latitude: null })) =>
    bookmarkRows({ plan: plan(stops), system: SYSTEM, status: s, bio: b as never });

  it("shows what is still to sample on the body now, not when it was saved", () => {
    const now = bio({
      species: [
        { species: "Frutexa Acus", analysed: true },
        { species: "Tussock Pennata", analysed: true },
      ],
      not_started: ["Bacterium", "Concha"],
      genera: ["Bacterium", "Concha", "Frutexa", "Tussock"],
      bio_signals: 4,
    });
    expect(rows([now])[0]!.text).toBe("📍 Bio: Bacterium, Concha");
    const done = bio({
      species: [{ species: "Frutexa Acus", analysed: true }],
      genera: ["Frutexa"],
      bio_signals: 1,
    });
    expect(rows([done])[0]!.text).toBe("📍 Bio: all sampled");
    // One genus with two species: both analysed account for both signals.
    const twoOfOne = bio({
      species: [
        { species: "Bacterium Cerbrus", analysed: true },
        { species: "Bacterium Aurasus", analysed: true },
      ],
      genera: ["Bacterium"],
      bio_signals: 2,
    });
    expect(bioLeft(twoOfOne)).toEqual([]);
    // Two species of one genus started and another genus not started: all 3 signals are known.
    const mixed = bio({
      species: [
        { species: "A one", analysed: true },
        { species: "A two", analysed: false },
      ],
      not_started: ["B"],
      genera: ["A", "B"],
      bio_signals: 3,
    });
    expect(bioLeft(mixed)).toEqual(["A two", "B"]);
    expect(rows([twoOfOne])[0]!.text).toBe("📍 Bio: all sampled");
    // Spansh's count shows the signals still unknown.
    expect(
      bookmarkRows({
        plan: plan([mark]),
        system: SYSTEM,
        status: status({ latitude: null }),
        bio: [{ ...(done as object), bio_signals: null }] as never,
        known: [{ bodyId: 6, bioSignals: 3 }] as never,
      })[0]!.text,
    ).toBe("📍 Bio: 2 signals");
    // With no signal count the body may hold more.
    expect(rows([{ ...(done as object), bio_signals: null }])[0]!.text).toBe(
      "📍 Bio: all found sampled, more may be here",
    );
    // A second bookmark's " (2)" stays, so the two rows still differ.
    expect(rows([now], [{ ...mark, label: `${mark.label} (2)` }])[0]!.text).toBe(
      "📍 Bio: Bacterium, Concha (2)",
    );
  });

  it("keeps a label the player or Claude chose, and the saved one without the journal", () => {
    const now = bio({ not_started: ["Concha"], genera: ["Concha"], bio_signals: 1 });
    expect(rows([now], [{ ...mark, label: "Concha by the crater" }])[0]!.text).toBe(
      "📍 Concha by the crater",
    );
    // A "Bio: " label without the key's note is someone's own, and kept.
    expect(rows([now], [{ ...mark, notes: undefined }])[0]!.text).toBe(`📍 ${mark.label}`);
    expect(rows([now], [{ ...mark, kind: "other" }])[0]!.text).toBe(`📍 ${mark.label}`);
    expect(rows([])[0]!.text).toBe(`📍 ${mark.label}`);
    expect(
      bookmarkRows({ plan: plan([mark]), system: SYSTEM, status: status({ latitude: null }) })[0]!
        .text,
    ).toBe(`📍 ${mark.label}`);
  });

  it("reads the biology from the journal in the panel", () => {
    const e = (event: string, o: object) =>
      ({ timestamp: "2026-11-22T10:00:00Z", event, ...o }) as unknown as JournalEvent;
    const events = [
      e("FSDJump", { StarSystem: SYSTEM, SystemAddress: 7 }),
      e("SAASignalsFound", {
        SystemAddress: 7,
        BodyID: 6,
        BodyName: BODY,
        Signals: [{ Type: "$SAA_SignalType_Biological;", Count: 2 }],
        Genuses: [
          { Genus: "$Codex_Ent_Bacterial_Genus_Name;", Genus_Localised: "Bacterium" },
          { Genus: "$Codex_Ent_Conchas_Genus_Name;", Genus_Localised: "Concha" },
        ],
      }),
    ];
    const input: HudInput = {
      journal: {
        location: { system: SYSTEM, station: null, station_type: null, docked: false },
        ship: { type: null, cargo_capacity: null },
        cargo: [],
        missions: [],
        events,
      } as unknown as HudInput["journal"],
      status: status({ body: `${SYSTEM} 5` }),
      nav: null,
      activity: null,
      plan: null,
      hotkey: { mode: "route", at: Date.UTC(2026, 10, 22) },
      samples: new Map(),
      known: null,
      settings: DEFAULT_SETTINGS.hud,
      now: Date.UTC(2026, 10, 22),
      bookmarks: plan([mark]),
    };
    expect(buildHud(input, null).panel?.rows[0]?.text).toBe("📍 1 bookmark on 6 k");
    // On the body, the row says what is still to sample there.
    const on = { ...input, status: status({ latitude: null }) };
    expect(buildHud(on, null).panel?.rows[0]?.text).toBe("📍 Bio: Bacterium, Concha");
  });
});
