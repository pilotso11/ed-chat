import { describe, expect, it } from "vitest";
import { exploration, type JournalEvent, type Plan } from "ed-mcp/journal";
import { syncDirOf } from "../src/core/edMcp.js";
import { HudFeed } from "../src/core/hud/feed.js";
import { buildHud, currentMode, parseShipStatus, type HudInput } from "../src/core/hud/hud.js";
import { LAPSE_JUMPS, cycleMode, journalMode, noteMode, pickMode } from "../src/core/hud/mode.js";
import {
  credits,
  navRouteCleared,
  nextStopAfter,
  previousStop,
  explorationTotals,
  exobiologyPanel,
  explorationPanel,
  jumpsLeft,
  massacrePanel,
  parseNavRoute,
  routeRows,
  sampleKey,
  shortBody,
  timeLeft,
} from "../src/core/hud/panels.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

let t = 0;
const ev = (event: string, extra: Record<string, unknown> = {}): JournalEvent => ({
  timestamp: new Date(Date.UTC(2026, 10, 15, 10, 0, t++)).toISOString(),
  event,
  ...extra,
});
const massacreAccepted = () =>
  ev("MissionAccepted", { Name: "Mission_MassacreWing", KillCount: 20, MissionID: 1 });
const BIO = { Type: "$SAA_SignalType_Biological;", Count: 2 };

describe("journalMode", () => {
  it("starts nothing on a jump alone", () => {
    expect(journalMode([ev("FSDJump"), ev("FSDJump")], false)).toBeNull();
  });

  it("turns on massacre mode for a massacre mission while one is open", () => {
    expect(journalMode([massacreAccepted()], true)?.mode).toBe("massacre");
  });

  it("shows the exploration mode once the stack is handed in", () => {
    const events = [ev("FSSDiscoveryScan", { SystemAddress: 1 }), massacreAccepted()];
    expect(journalMode(events, false)?.mode).toBe("exploration");
    expect(journalMode([massacreAccepted()], false)).toBeNull();
  });

  it("keeps what was scanned during and after a finished massacre stack", () => {
    // The panel showed the activity note's mode instead, since this came out empty.
    const events = [massacreAccepted(), ev("ScanOrganic", { ScanType: "Log" })];
    // Dated by the sample, so it beats an activity note older than the sample.
    expect(journalMode(events, false)).toEqual({
      mode: "exobiology",
      at: Date.parse(events[1]!.timestamp),
    });
    expect(journalMode(events, true)?.mode).toBe("massacre");
  });

  it("counts a massacre acceptance with no readable time", () => {
    const jump = ev("FSDJump");
    const bad = { ...massacreAccepted(), timestamp: "" };
    expect(journalMode([jump, bad], true)).toEqual({
      mode: "massacre",
      at: Date.parse(jump.timestamp),
    });
  });

  it("dates a scan or sample with no readable time by the newest readable event", () => {
    const jump = ev("FSDJump");
    const sample = { ...ev("ScanOrganic", { ScanType: "Log" }), timestamp: "" };
    expect(journalMode([ev("FSSDiscoveryScan"), jump, sample], false)).toEqual({
      mode: "exobiology",
      at: Date.parse(jump.timestamp),
    });
  });

  it("does not leave massacre mode for a scan while missions are open", () => {
    const events = [massacreAccepted(), ev("Scan", { ScanType: "Detailed" })];
    expect(journalMode(events, true)?.mode).toBe("massacre");
  });

  it("turns on exploration for a discovery scan or a detailed scan, not an auto scan", () => {
    expect(journalMode([ev("FSSDiscoveryScan")], false)?.mode).toBe("exploration");
    expect(journalMode([ev("Scan", { ScanType: "Detailed" })], false)?.mode).toBe("exploration");
    expect(journalMode([ev("Scan", { ScanType: "AutoScan" })], false)).toBeNull();
  });

  it("ends exploration after jumps with no scan", () => {
    const jumps = Array.from({ length: LAPSE_JUMPS }, () => ev("FSDJump"));
    expect(journalMode([ev("FSSDiscoveryScan"), ...jumps], false)).toBeNull();
    expect(journalMode([ev("FSSDiscoveryScan"), ...jumps.slice(1)], false)?.mode).toBe(
      "exploration",
    );
  });

  it("counts jumps during a massacre stack toward the end of exploration", () => {
    const jumps = Array.from({ length: LAPSE_JUMPS }, () => ev("FSDJump"));
    expect(journalMode([ev("FSSDiscoveryScan"), massacreAccepted(), ...jumps], false)).toBeNull();
  });

  it("turns on exobiology near a body with bio signals, and back to exploration on leaving", () => {
    const signals = ev("FSSBodySignals", { SystemAddress: 1, BodyID: 4, Signals: [BIO] });
    const approach = ev("ApproachBody", { SystemAddress: 1, BodyID: 4 });
    expect(journalMode([signals, approach], false)?.mode).toBe("exobiology");
    expect(journalMode([ev("ApproachBody", { SystemAddress: 1, BodyID: 5 })], false)).toBeNull();
    const leave = ev("LeaveBody", { SystemAddress: 1, BodyID: 4 });
    expect(journalMode([signals, approach, leave], false)?.mode).toBe("exploration");
    // With exploration off, leaving the body ends exobiology all the same.
    const noExplore = (m: string) => m !== "exploration";
    expect(journalMode([signals, approach, leave], false, false, noExplore)).toBeNull();
  });

  it("turns on exobiology for a sample", () => {
    expect(journalMode([ev("ScanOrganic", { ScanType: "Log" })], false)?.mode).toBe("exobiology");
  });
});

describe("choosing the mode", () => {
  it("takes the newest choice", () => {
    expect(pickMode({ mode: "massacre", at: 1 }, null, { mode: "route", at: 2 })?.mode).toBe(
      "route",
    );
    expect(pickMode(null, undefined)).toBeNull();
  });

  it("cycles auto, each enabled mode, off", () => {
    const on = ["massacre", "exploration"] as const;
    expect(cycleMode("auto", [...on])).toBe("massacre");
    expect(cycleMode("exploration", [...on])).toBe("off");
    expect(cycleMode("off", [...on])).toBe("auto");
  });

  it("maps the activity note's kind", () => {
    expect(noteMode("massacre")).toBe("massacre");
    expect(noteMode("trading")).toBeNull();
    expect(noteMode(undefined)).toBeNull();
  });
});

const baseInput = (over: Partial<HudInput> = {}): HudInput => ({
  journal: null,
  status: null,
  nav: null,
  activity: null,
  plan: null,
  hotkey: null,
  samples: new Map(),
  known: null,
  settings: DEFAULT_SETTINGS.hud,
  now: Date.UTC(2026, 10, 15, 12),
  ...over,
});

describe("currentMode", () => {
  it("holds off from the hotkey over every other choice", () => {
    const activity = {
      kind: "massacre" as const,
      summary: "x",
      updated_at: "2026-11-15T11:00:00Z",
    };
    expect(currentMode(baseInput({ activity }))).toBe("massacre");
    expect(currentMode(baseInput({ activity, hotkey: { mode: "off", at: 0 } }))).toBe("off");
  });

  it("ignores a mode turned off in settings", () => {
    const activity = { kind: "massacre" as const, summary: "x", updated_at: "2026-11-15T11:00Z" };
    const settings = {
      ...DEFAULT_SETTINGS.hud,
      modes: { ...DEFAULT_SETTINGS.hud.modes, massacre: false },
    };
    expect(currentMode(baseInput({ activity, settings }))).toBeNull();
  });

  it("shows nothing at all when off", () => {
    const v = buildHud(baseInput({ hotkey: { mode: "off", at: 0 } }), null);
    expect(v.panel).toBeNull();
    expect(v.route).toBeNull();
  });
});

describe("massacrePanel", () => {
  const mission = (id: number, required: number, counted: number, expires: string | null) => ({
    id,
    name: "Kill pirates",
    accepted: "2026-11-15T09:00:00Z",
    expires,
    reward: 1_000_000,
    kills_required: required,
    kills_counted: counted,
    kills_left: required - counted,
    done: counted >= required,
  });

  it("shows each giver's progress, the stack and the next expiry", () => {
    const p = massacrePanel(
      [
        {
          target_faction: "Kumo Crew",
          kills_left: 12,
          factions: [
            {
              faction: "Lugh",
              kills_left: 12,
              missions: [mission(1, 30, 18, "2026-11-16T16:00:00Z")],
            },
            { faction: "Eravate", kills_left: 0, missions: [mission(2, 10, 10, null)] },
          ],
        },
      ],
      Date.UTC(2026, 10, 15, 12),
      { minPerKill: 0 },
    )!;
    expect(p.right).toBe("12 left");
    // The unfinished mission's 1.0M over the 12 kills left.
    expect(p.rows[0]).toMatchObject({
      text: "Kumo Crew",
      right: "12 left · 83k/kill",
      tone: "accent",
    });
    expect(p.rows[1]).toMatchObject({ text: "Lugh", right: "18/30", bar: 0.6 });
    expect(p.rows[2]).toMatchObject({ text: "Eravate", tone: "good" });
    expect(p.footer).toEqual(["Stack 2.0M · 1 ready to hand in 1.0M", "next expires 1d 4h"]);
  });

  it("marks a target that pays too little a kill left", () => {
    const groups = (reward: number | null) => [
      {
        target_faction: "Kumo Crew",
        kills_left: 10,
        factions: [
          { faction: "Lugh", kills_left: 10, missions: [{ ...mission(1, 10, 0, null), reward }] },
        ],
      },
    ];
    const low = massacrePanel(groups(15_000_000), 0, { minPerKill: 2_000_000 })!;
    expect(low.rows[0]).toMatchObject({ right: "10 left · ⚠ 1.5M/kill", tone: "accent" });
    expect(low.rows[1]!.text).toBe("Lugh");
    const ok = massacrePanel(groups(25_000_000), 0, { minPerKill: 2_000_000 })!;
    expect(ok.rows[0]).toMatchObject({ right: "10 left · 2.5M/kill", tone: "accent" });
    // A reward missing from the journal: the values are floors, and a floor is not marked.
    const missing = massacrePanel(groups(null), 0, { minPerKill: 2_000_000 })!;
    expect(missing.footer[0]).toBe("Stack 0+");
    expect(missing.rows[0]!.right).toBe("10 left · 0+/kill");
    // Judged as shown: 999,999 a kill reads 1.0M, so it is not under 1.0M.
    const edge = massacrePanel(groups(9_999_990), 0, { minPerKill: 1_000_000 })!;
    expect(edge.rows[0]!.right).toBe("10 left · 1.0M/kill");
    expect(massacrePanel(groups(14_600_000), 0, { minPerKill: 1_500_000 })!.rows[0]!.right).toBe(
      "10 left · 1.5M/kill",
    );
    expect(massacrePanel(groups(14_400_000), 0, { minPerKill: 1_500_000 })!.rows[0]!.right).toBe(
      "10 left · ⚠ 1.4M/kill",
    );
  });

  it("is null with no missions", () => {
    expect(massacrePanel([], 0, { minPerKill: 0 })).toBeNull();
  });
});

describe("exploration totals", () => {
  const elw = (system: string, id: number) =>
    ev("Scan", {
      ScanType: "Detailed",
      StarSystem: system,
      SystemAddress: id,
      BodyID: 1,
      PlanetClass: "Earthlike body",
      MassEM: 1,
      WasDiscovered: true,
      WasMapped: true,
    });

  it("adds unsold scans and mapping, and drops systems when sold", () => {
    const scanned = explorationTotals([ev("LoadGame"), ev("FSDJump"), elw("A", 1), elw("B", 2)]);
    expect(scanned.unsoldCartographic).toBe(283629 * 2);
    expect(scanned.session).toEqual({ systems: 1, scanned: 2, mapped: 0, firstDiscoveries: 0 });
    const mapped = explorationTotals([
      elw("A", 1),
      ev("SAAScanComplete", { SystemAddress: 1, BodyID: 1 }),
    ]);
    expect(mapped.unsoldCartographic).toBeGreaterThan(283629 * 4);
    const sold = explorationTotals([
      elw("A", 1),
      elw("B", 2),
      ev("SellExplorationData", { Systems: ["A"] }),
    ]);
    expect(sold.unsoldCartographic).toBe(283629);
  });

  it("keeps a body discovered and mapped by others when a newer scan says not", () => {
    // Seen in a journal: an AutoScan on arrival, then the FSS's Detailed scan a minute later.
    const later = ev("Scan", {
      ScanType: "Detailed",
      StarSystem: "A",
      SystemAddress: 1,
      BodyID: 1,
      PlanetClass: "Earthlike body",
      MassEM: 1,
      WasDiscovered: false,
      WasMapped: false,
    });
    const map = ev("SAAScanComplete", { SystemAddress: 1, BodyID: 1 });
    const known = explorationTotals([elw("A", 1), map]).unsoldCartographic;
    expect(explorationTotals([elw("A", 1), later, map]).unsoldCartographic).toBe(known);
    expect(explorationTotals([elw("A", 1), later, map]).session.firstDiscoveries).toBe(0);
    expect(explorationTotals([later]).session.firstDiscoveries).toBe(1);
    // A scan saying discovered after the detailed scan undoes the count too.
    expect(explorationTotals([later, elw("A", 1)]).session.firstDiscoveries).toBe(0);
    // Selling tags the body as the player's, so a rescan after the sale keeps the count.
    const sell = ev("SellExplorationData", { Systems: ["A"] });
    expect(explorationTotals([later, sell, elw("A", 1)]).session.firstDiscoveries).toBe(1);
    // A body settled by a sale counts once, whatever later scans say.
    expect(explorationTotals([later, sell, later]).session.firstDiscoveries).toBe(1);
    // A new game session starts the count again.
    expect(explorationTotals([later, ev("LoadGame")]).session.firstDiscoveries).toBe(0);
    expect(explorationTotals([later, sell, ev("LoadGame")]).session.firstDiscoveries).toBe(0);
    expect(explorationTotals([later, map]).unsoldCartographic).toBeGreaterThan(known);
  });

  it("works out credits an hour for the session, the last half hour and each planet", () => {
    const T = Date.UTC(2026, 10, 15, 10);
    const at = (min: number) => new Date(T + min * 60_000).toISOString();
    const timed = (min: number, e: JournalEvent) => ({ ...e, timestamp: at(min) });
    const analyse = (min: number, body: number) =>
      timed(
        min,
        ev("ScanOrganic", {
          ScanType: "Analyse",
          Species: "$Codex_Ent_Stratum_07_Name;",
          SystemAddress: 1,
          Body: body,
        }),
      );
    const value = explorationTotals([analyse(0, 3)]).unsoldBio;
    expect(value).toBeGreaterThan(0);
    const jump = (min: number) => timed(min, ev("FSDJump", { SystemAddress: 1 }));
    const body = (event: string, min: number, id: number) =>
      timed(min, ev(event, { SystemAddress: 1, BodyID: id }));
    const events = [
      timed(0, ev("LoadGame")),
      jump(0),
      body("ApproachBody", 5, 3),
      analyse(10, 3),
      body("LeaveBody", 12, 3),
      jump(20),
      body("ApproachBody", 25, 3),
      analyse(30, 3),
      jump(38),
      analyse(40, 4),
    ];
    const min = (n: number) => T + n * 60_000;
    // Too soon after the session starts to say.
    expect(explorationTotals(events.slice(0, 2), min(1)).rate).toEqual({
      session: null,
      recent: null,
    });
    const t = explorationTotals(events, min(45));
    // Three species over 45 minutes.
    expect(t.rate.session).toBeCloseTo((3 * value * 60) / 45);
    // The last half hour has two of them.
    expect(t.rate.recent).toBeCloseTo(value * 4);
    // Body 3: 7 minutes on the first visit and 20 on the second, with both species; coming back
    // keeps the first visit. Body 4 from its first sample, 5 minutes ago.
    expect(t.planetRate.get("1|3")).toBeCloseTo((2 * value * 60) / 27);
    expect(t.planetRate.get("1|4")).toBeCloseTo(value * 12);
    // Time away counts only 10 minutes: two hours docked after 10 minutes of work is 20.
    const idle = explorationTotals(
      events.slice(0, 4).filter((e) => e.event !== "ApproachBody"),
      min(125),
    );
    expect(idle.rate.session).toBeCloseTo((value * 60) / 20);

    // A rescan adds nothing; mapping adds what the map is worth. Ten minutes in each case.
    const elwWorth = explorationTotals([elw("A", 1)]).unsoldCartographic;
    const scans = [timed(0, ev("LoadGame")), timed(0, elw("A", 1)), timed(5, elw("A", 1))];
    const once = explorationTotals(scans, min(10)).rate.session!;
    expect(once).toBeCloseTo(elwWorth * 6);
    const map = body("SAAScanComplete", 6, 1);
    const mappedWorth = explorationTotals([elw("A", 1), map]).unsoldCartographic;
    expect(explorationTotals([...scans, map], min(10)).rate.session!).toBeCloseTo(mappedWorth * 6);
    // A sale does not take back what was earned.
    const sold = [...scans, timed(7, ev("SellExplorationData", { Systems: ["A"] }))];
    expect(explorationTotals(sold, min(10)).rate.session!).toBeCloseTo(once);
    // Dying loses the data, so scanning the body again earns again.
    const died = [
      timed(0, ev("LoadGame")),
      timed(0, elw("A", 1)),
      timed(1, ev("Died")),
      timed(2, elw("A", 1)),
    ];
    expect(explorationTotals(died, min(10)).rate.session!).toBeCloseTo(elwWorth * 2 * 6);
  });

  it("keeps a planet's time and worth over a relog, a map and time away", () => {
    const T = Date.UTC(2026, 10, 15, 10);
    const min = (n: number) => T + n * 60_000;
    const timed = (n: number, e: JournalEvent) => ({
      ...e,
      timestamp: new Date(min(n)).toISOString(),
    });
    const body = (event: string, n: number, extra: Record<string, unknown> = {}) =>
      timed(n, ev(event, { SystemAddress: 1, BodyID: 3, ...extra }));
    const analyse = (n: number) =>
      timed(
        n,
        ev("ScanOrganic", {
          ScanType: "Analyse",
          Species: "$Codex_Ent_Stratum_07_Name;",
          SystemAddress: 1,
          Body: 3,
        }),
      );
    const species = explorationTotals([analyse(0)]).unsoldBio;
    const planet = ev("Scan", {
      ScanType: "Detailed",
      StarSystem: "A",
      SystemAddress: 1,
      BodyID: 3,
      PlanetClass: "Water world",
      TerraformState: "Terraformable",
      MassEM: 1,
      WasDiscovered: true,
      WasMapped: true,
    });
    const scanned = explorationTotals([planet]).unsoldCartographic;
    const mapped = explorationTotals([planet, body("SAAScanComplete", 0)]).unsoldCartographic;
    const events = [
      timed(0, ev("LoadGame")),
      timed(0, planet),
      // Mapping starts the planet's clock, and the map's worth counts toward it.
      body("SAAScanComplete", 5),
      analyse(10),
      // A relog on the planet keeps its time and worth; the next sample starts its clock again.
      timed(12, ev("LoadGame")),
      analyse(20),
    ];
    const t = explorationTotals(events, min(25));
    // 5 to 10, the last event before the relog, and 20 to 25: 10 minutes, with the map and two
    // species.
    expect(t.planetRate.get("1|3")).toBeCloseTo(((mapped - scanned + 2 * species) * 60) / 10);
    // The new session: from the sample at 20, five minutes.
    expect(t.rate.session).toBeCloseTo(species * 12);
    // Quitting, or a relog after a long break with no Shutdown (a crash), adds nothing to the
    // planet's time when sampling starts again an hour later: 7 minutes, to the Shutdown, or 5,
    // to the last event before the relog.
    const before = events.slice(0, 4);
    for (const quit of [[timed(12, ev("Shutdown"))], []]) {
      const relog = explorationTotals(
        [
          ...before,
          ...quit,
          // A new game's journal starts with these.
          timed(72, ev("Fileheader")),
          timed(72, ev("Commander")),
          timed(72, ev("LoadGame")),
          analyse(80),
        ],
        min(80),
      );
      expect(relog.planetRate.get("1|3")).toBeCloseTo(
        ((mapped - scanned + 2 * species) * 60) / (quit.length ? 7 : 5),
      );
    }
    // A journal that fills rolls over to its next part with a Fileheader mid-game: the planet's
    // clock keeps running, 5 to 12.
    const rolled = explorationTotals(
      [...before, timed(12, ev("Fileheader", { part: 2 })), analyse(12)],
      min(12),
    );
    expect(rolled.planetRate.get("1|3")).toBeCloseTo(((mapped - scanned + 2 * species) * 60) / 7);
    // The last half hour leaves out time away that ended before it: 40 minutes of jumps, then
    // an hour away, has no time in the window, so no rate rather than 0/h.
    const jumps = [timed(0, ev("LoadGame"))];
    for (let n = 0; n <= 40; n += 5) jumps.push(timed(n, ev("FSDJump", { SystemAddress: 1 })));
    expect(explorationTotals(jumps, min(100)).rate.recent).toBeNull();
    // Coming back closes the gap with a jump at 100: the window still has none of the time away,
    // only the 5 minutes of work after it.
    const back = [...jumps, timed(100, ev("FSDJump", { SystemAddress: 1 })), analyse(105)];
    expect(explorationTotals(back, min(105)).rate.recent).toBeCloseTo(species * 12);
    // Dying stops the planet's clock: an hour later it still has its 7 minutes.
    const died = explorationTotals([...events.slice(0, 4), timed(12, ev("Died"))], min(72));
    expect(died.planetRate.get("1|3")).toBeCloseTo(((mapped - scanned + species) * 60) / 7);
    // Time away counts at most 10 minutes in the last half hour too: after 50 minutes of work
    // and 25 away, it is the 5 minutes of work in it and 10 of the time away.
    const work = [timed(0, ev("LoadGame")), timed(0, ev("FSDJump", { SystemAddress: 1 }))];
    for (let n = 5; n <= 50; n += 5) work.push(timed(n, ev("FSDJump", { SystemAddress: 1 })));
    work.push(analyse(50));
    const away = explorationTotals(work, min(75));
    expect(away.rate.recent).toBeCloseTo((species * 60) / 15);
  });

  it("shows the rate on the exploration panel's Session line, even with no jumps or scans", () => {
    const totals = {
      unsoldCartographic: 0,
      unsoldBio: 0,
      unsoldBioCount: 0,
      session: { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 },
      rate: { session: 52_000_000, recent: null },
      planetRate: new Map(),
    };
    const p = explorationPanel({
      system: "Sys",
      exploration: exploration([], 1),
      bio: [],
      totals,
      valuableMin: 0,
    });
    expect(p.footer).toEqual(["Session: 0 jumps · 0 scanned · 0 mapped · 0 ★ · 52.0M/h"]);
  });

  it("shows the session rate once on the exobiology panel", () => {
    const totals = {
      unsoldCartographic: 0,
      unsoldBio: 0,
      unsoldBioCount: 0,
      session: { systems: 3, scanned: 2, mapped: 0, firstDiscoveries: 0 },
      rate: { session: 52_000_000, recent: 80_000_000 },
      planetRate: new Map([["7|3", 30_000_000]]),
    };
    const p = exobiologyPanel({
      system: "Sys",
      address: 7,
      body: {
        body: "Sys 3",
        body_id: 3,
        species: [],
        not_started: [],
        genera: [],
      } as unknown as Parameters<typeof exobiologyPanel>[0]["body"],
      samples: new Map(),
      here: null,
      totals,
    });
    // Nothing unsold: the Session line stays, without the rate the Rate line has.
    expect(p.footer).toEqual([
      "Session: 3 jumps · 2 scanned · 0 mapped · 0 ★",
      "Rate: this planet 30.0M/h · session 52.0M/h (30m 80.0M/h)",
    ]);
  });

  it("keeps only systems within 20 ly of the station after a sale", () => {
    const jump = (id: number, pos: number[]) => ev("FSDJump", { SystemAddress: id, StarPos: pos });
    const t = explorationTotals([
      jump(1, [0, 0, 0]),
      elw("A", 1),
      jump(2, [100, 0, 0]),
      elw("B", 2),
      jump(3, [110, 0, 0]),
      elw("C", 3),
      ev("MultiSellExplorationData", { Discovered: [{ SystemName: "C" }] }),
    ]);
    // A was far and not sold, so it was not for sale; B is 10 ly away and held back.
    expect(t.unsoldCartographic).toBe(283629);
  });

  it("adds analysed species until sold", () => {
    const analyse = ev("ScanOrganic", {
      ScanType: "Analyse",
      Species: "$Codex_Ent_Stratum_06_Name;",
    });
    expect(explorationTotals([analyse])).toMatchObject({ unsoldBio: 16202800, unsoldBioCount: 1 });
    expect(explorationTotals([analyse, ev("SellOrganicData")]).unsoldBioCount).toBe(0);
  });

  it("pays five times for species from a planet nobody had set foot on", () => {
    const scan = (WasFootfalled: boolean) =>
      ev("Scan", { SystemAddress: 7, BodyID: 3, BodyName: "Sys 3", WasFootfalled });
    const analyse = ev("ScanOrganic", {
      ScanType: "Analyse",
      SystemAddress: 7,
      Body: 3,
      Species: "$Codex_Ent_Stratum_06_Name;",
    });
    expect(explorationTotals([scan(false), analyse]).unsoldBio).toBe(16202800 * 5);
    expect(explorationTotals([scan(true), analyse]).unsoldBio).toBe(16202800);
    expect(explorationTotals([scan(true), scan(false), analyse]).unsoldBio).toBe(16202800);
    expect(explorationTotals([scan(false), scan(true), analyse]).unsoldBio).toBe(16202800);
  });
});

describe("route keys", () => {
  // Listed A, B, C, D; visited C, A, B, D.
  const plan = (statuses: ("todo" | "done" | "skipped")[]): Plan => ({
    id: "trip",
    name: "Trip",
    items: [],
    stops: statuses.map((status, i) => ({ system: "ABCD"[i]!, purpose: "go", status })),
    route: {
      computed_at: "",
      from: "Here",
      stops: ["C", "A", "B", "D"],
      total_min: 0,
      plotted: true,
      stop_indexes: [[2], [0], [1], [3]],
    },
    created_at: "",
    updated_at: "",
  });

  it("goes back to the stop done last in visit order, not in listing order", () => {
    // C then A done: going back undoes A.
    expect(previousStop(plan(["done", "todo", "done", "todo"]))).toBe(0);
    // A skipped stop stays skipped.
    expect(previousStop(plan(["skipped", "todo", "done", "todo"]))).toBe(2);
    expect(previousStop(plan(["todo", "todo", "todo", "todo"]))).toBeNull();
  });

  it("copies the next stop in visit order on arrival", () => {
    // At C, the first stop in visit order: next is A.
    expect(nextStopAfter(plan(["todo", "todo", "todo", "todo"]), 2)).toBe(0);
    // At A: next is B, not C, which is listed later but visited earlier.
    expect(nextStopAfter(plan(["todo", "todo", "done", "todo"]), 0)).toBe(1);
  });

  it("forgets a route cleared in the game", () => {
    expect(navRouteCleared([ev("NavRoute"), ev("NavRouteClear")])).toBe(true);
    expect(navRouteCleared([ev("NavRouteClear"), ev("NavRoute")])).toBe(false);
    expect(navRouteCleared([])).toBe(false);
  });
});

describe("route line", () => {
  const plan = (statuses: ("todo" | "done")[]): Plan => ({
    id: "trip",
    name: "Trip",
    items: [],
    stops: statuses.map((status, i) => ({
      system: `Sys ${i}`,
      purpose: "go",
      status,
      ...(i === 1 ? { body: "A 5" } : {}),
    })),
    created_at: "",
    updated_at: "",
  });
  const nav = parseNavRoute(
    JSON.stringify({
      Route: [{ StarSystem: "Here" }, { StarSystem: "Mid" }, { StarSystem: "Sys 1" }],
    }),
  );

  it("shows the current stop with jumps left, and the next stop", () => {
    expect(routeRows({ plan: plan(["done", "todo", "todo"]), nav, system: "Here" })).toEqual([
      { kind: "current", text: "Sys 1 A 5", right: "2 jumps" },
      { kind: "next", text: "Sys 2" },
    ]);
  });

  it("skips stops already done after the current one", () => {
    const rows = routeRows({
      plan: plan(["todo", "done", "todo", "todo"]),
      nav: null,
      system: "Here",
    });
    expect(rows!.map((r) => [r.kind, r.text])).toEqual([
      ["current", "Sys 0"],
      ["next", "Sys 2"],
      ["more", "+1 more stop"],
    ]);
  });

  it("names the body or station, and the current stop's label", () => {
    const p: Plan = {
      ...plan(["done", "todo", "todo", "todo", "todo"]),
      stops: [
        { system: "Col 1", body: "4 d", purpose: "x", status: "done" },
        { system: "Col 1", body: "Col 1 5 a", purpose: "x", status: "todo", label: "Nitris" },
        { system: "Col 1", body: "6", purpose: "x", status: "todo" },
        { system: "Shinrarta", station: "Jameson", purpose: "x", status: "todo" },
        { system: "Col 2", body: "Col 2 A 1", purpose: "x", status: "todo" },
      ],
    };
    expect(routeRows({ plan: p, nav: null, system: "Col 1" })).toEqual([
      { kind: "current", text: "Col 1 5 a" },
      { kind: "label", text: "Nitris" },
      { kind: "next", text: "6" },
      { kind: "more", text: "+2 more stops" },
    ]);
    const atStation = {
      ...p,
      stops: p.stops.map((s, i) => (i < 3 ? { ...s, status: "done" as const } : s)),
    };
    expect(routeRows({ plan: atStation, nav: null, system: "Col 1" })).toEqual([
      { kind: "current", text: "Jameson, Shinrarta" },
      { kind: "next", text: "Col 2 A 1" },
    ]);
  });

  it("shows only the destination and jumps with no plan", () => {
    expect(routeRows({ plan: null, nav, system: "Mid" })).toEqual([
      { kind: "current", text: "Sys 1", right: "1 jump" },
    ]);
    expect(routeRows({ plan: null, nav: null, system: "Mid" })).toBeNull();
  });

  it("counts jumps from where the ship is on the route", () => {
    expect(jumpsLeft(nav, "Sys 1")).toBeNull();
    expect(jumpsLeft(nav, "Elsewhere")).toBe(2);
    expect(parseNavRoute('{"Route":[]}')).toBeNull();
  });
});

describe("helpers", () => {
  it("formats credits and times", () => {
    expect(credits(2_140_000)).toBe("2.1M");
    expect(credits(840_400)).toBe("840k");
    // Not 1000k or 1000.0M at the edge of the next unit.
    expect(credits(999_999)).toBe("1.0M");
    expect(credits(999_499)).toBe("999k");
    expect(credits(999_999_999)).toBe("1.0B");
    expect(timeLeft(-1)).toBe("expired");
    expect(timeLeft(3 * 3600_000 + 20 * 60_000)).toBe("3h 20m");
  });

  it("shortens body names", () => {
    expect(shortBody("Col 285 Sector AB-C d1 A 3", "Col 285 Sector AB-C d1")).toBe("A 3");
    expect(shortBody("Other 1", "Col 285")).toBe("Other 1");
  });

  it("reads the ship's position from Status.json", () => {
    expect(
      parseShipStatus('{"BodyName":"X 1","Latitude":1.5,"Longitude":-2,"PlanetRadius":3e6}'),
    ).toEqual({ body: "X 1", latitude: 1.5, longitude: -2, radius: 3e6, heading: null });
    expect(parseShipStatus("{")).toBeNull();
  });

  it("finds ed-mcp's sync folder in Claude Code's config, and nothing else", () => {
    const cfg = (env: Record<string, string>) =>
      JSON.stringify({ mcpServers: { "ed-mcp": { command: "npx", env } } });
    expect(
      syncDirOf({ claudeJson: cfg({ ED_MCP_SYNC_DIR: "D:\\Sync", ED_MCP_SYNC_PASSWORD: "x" }) }),
    ).toBe("D:\\Sync");
    expect(syncDirOf({ claudeJson: cfg({}) })).toBeNull();
    const project = JSON.stringify({
      projects: { p: { mcpServers: { "ed-mcp": { env: { ED_MCP_SYNC_DIR: "E:\\S" } } } } },
    });
    expect(syncDirOf({ claudeJson: project })).toBe("E:\\S");
    expect(syncDirOf({ claudeJson: "not json" })).toBeNull();
  });
});

describe("HudFeed sample positions", () => {
  it("records where samples are taken after start, and forgets them once analysed", async () => {
    const events: JournalEvent[] = [
      ev("ScanOrganic", { ScanType: "Log", Body: 3, Species_Localised: "Old", Species: "o" }),
    ];
    let status = '{"Latitude":10,"Longitude":20,"PlanetRadius":1000000}';
    const stores = {
      journal: { state: async () => ({ events, missions: [], location: { system: "S" } }) },
      activity: { get: async () => null },
      plans: { get: async () => null },
    };
    const feed = new HudFeed(stores as never, "J", {
      read: async (f) => (f.endsWith("Status.json") ? status : "{}"),
    });
    await feed.poll();
    expect(feed.samples.size).toBe(0);
    const s = (type: string) =>
      ev("ScanOrganic", {
        ScanType: type,
        SystemAddress: 7,
        Body: 3,
        Species_Localised: "Bact",
        Species: "b",
      });
    events.push(s("Log"));
    await feed.poll();
    expect(feed.samples.get(sampleKey(7, 3, "Bact"))).toEqual([{ latitude: 10, longitude: 20 }]);
    status = '{"Latitude":11,"Longitude":20,"PlanetRadius":1000000}';
    events.push(s("Sample"));
    await feed.poll();
    expect(feed.samples.get(sampleKey(7, 3, "Bact"))).toHaveLength(2);
    events.push(s("Analyse"));
    await feed.poll();
    expect(feed.samples.has(sampleKey(7, 3, "Bact"))).toBe(false);
  });
});

describe("HudFeed bookmarks and a fresh Status.json", () => {
  const stores = (get: () => Promise<unknown>) => ({
    journal: { state: async () => ({ events: [], missions: [], location: { system: "S" } }) },
    activity: { get: async () => null },
    plans: { get },
  });

  it("reads Status.json again when it is caught mid-write", async () => {
    let reads = 0;
    const feed = new HudFeed(stores(async () => null) as never, "J", {
      read: async () => (++reads === 1 ? '{"Latitude":1' : '{"Latitude":1,"Longitude":2}'),
    });
    expect((await feed.readStatus())?.latitude).toBe(1);
    expect(reads).toBe(2);
  });

  it("takes no bookmarks plan as none, not as an error", async () => {
    const errors: string[] = [];
    const feed = new HudFeed(
      stores(async () => Promise.reject(new Error('Plan "bookmarks" not found'))) as never,
      "J",
      { read: async () => "{}", onError: (what) => errors.push(what) },
    );
    expect((await feed.poll()).bookmarks).toBeNull();
    expect(errors).toEqual([]);
  });
});
