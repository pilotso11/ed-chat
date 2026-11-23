import {
  exobiology,
  exploration,
  massacre,
  systemAddress,
  type Activity,
  type ExobiologyBody,
  type JournalEvent,
  type JournalState,
  type Plan,
} from "ed-mcp/journal";
import type { HudModeId, Settings } from "../settings.js";
import type { KnownBody } from "./known.js";
import { carrierState, miningPanel, miningState, minedWaiting } from "./mining.js";
import { drops, passengerPanel } from "./passenger.js";
import type { SellLookup, SellQuery } from "./sell.js";
import { bookmarkRows } from "./bookmarks.js";
import { same } from "./json.js";
import {
  isTradePlan,
  missionsNow,
  navLeadsTo,
  NO_MISSIONS,
  tradeCargo,
  tradeJournal,
  tradePanel,
  tradeTodo,
  type Market,
} from "./trade.js";
import { journalMode, noteMode, pickMode, type Choice } from "./mode.js";
import {
  buildNow,
  buildPanel,
  chooseBuild,
  outfittingVisit,
  visitPanel,
  type BuildChoice,
  type BuildVisit,
  type Outfitting,
} from "./build.js";
import { isBuildPlan } from "./buildJudge.js";
import {
  exobiologyPanel,
  explorationPanel,
  explorationTotals,
  bioRows,
  highlightRows,
  massacrePanel,
  routeRows,
  type RouteRow,
  type NavRoute,
  type PanelView,
  type Point,
  wasFootfalled,
  knownSignals,
  liveMassacre,
  currentStop,
} from "./panels.js";

/** What the panel window shows. */
export interface HudView {
  /** The mode chosen: currentMode(). */
  mode?: HudModeId | "off" | null;
  /** The mode's panel; null shows only the route line, or nothing. */
  panel: PanelView | null;
  /** The route, one stop to a row: the whole panel when there is no other, else below it. */
  route: RouteRow[] | null;
  /** While the move keys move the panel, not the chat: what to press. */
  moving: string | null;
  fontSize: number;
  backgroundOpacity: number;
  width: number;
  /** CSS variables for the colours and fonts; none uses the defaults. */
  look?: Record<string, string>;
  /**
   * The plan the route rows, the arrival copy and the route keys follow, when it is not the
   * note's (a build plan shown because the ship is docked at its stop), and the stop the build
   * panel shows as current when it is not currentStop().
   */
  follow?: { planId: string; stop: number | null };
}

export interface ShipStatus {
  body: string | null;
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
  /** Degrees, where the ship or commander faces; for turning toward a bookmark. */
  heading?: number | null;
  /** Credits held (Balance): the journal's credits change only at LoadGame. */
  balance?: number | null;
}

export function parseShipStatus(text: string): ShipStatus | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      body: typeof j.BodyName === "string" && j.BodyName ? j.BodyName : null,
      latitude: n(j.Latitude),
      longitude: n(j.Longitude),
      radius: n(j.PlanetRadius),
      heading: n(j.Heading),
      balance: n(j.Balance),
    };
  } catch {
    return null;
  }
}

export interface HudInput {
  journal: (JournalState & { events: JournalEvent[] }) | null;
  status: ShipStatus | null;
  nav: NavRoute | null;
  activity: Activity | null;
  plan: Plan | null;
  /** The mode chosen with the hotkey; "off" holds until the hotkey is pressed again. */
  hotkey: Choice | null;
  samples: Map<string, Point[]>;
  /** Spansh's planets for the current system, when looked up. */
  known: KnownBody[] | null;
  settings: Settings["hud"];
  now: number;
  /** Spansh's sale prices for the mining panel; none when the lookup is off. */
  sell?: (q: SellQuery) => SellLookup;
  /** The surface bookmarks plan, read each poll; null when there is none. */
  bookmarks?: Plan | null;
  /** CSS variables for the colours and fonts: the overlay's look. */
  look?: Record<string, string>;
  /** Market.json: the market of the last commodity screen opened, for the trade panel. */
  market?: Market | null;
  /** The open build plans (with stop actions), besides the note's plan. */
  buildPlans?: Plan[];
  /** Outfitting.json: the modules of the last outfitting screen opened, for the build panel. */
  outfitting?: Outfitting | null;
}

/** The build plan the panel would show now, with the journal read and the mode on. */
export function buildChoice(input: HudInput): BuildChoice | null {
  if (!input.settings.modes.build || !input.journal) return null;
  return chooseBuild({ note: input.plan, plans: input.buildPlans ?? [], journal: input.journal });
}

/** The outfitting visit the build panel would show now (outfittingVisit()), when it is on. */
export function buildVisit(input: HudInput, choice: BuildChoice | null): BuildVisit | null {
  const s = input.settings;
  if (!s.modes.build || !s.build.outfittingVisit || !input.journal) return null;
  return outfittingVisit(input.journal, choice);
}

/** The mode now: off by hotkey, else the newest of the journal, the note and the hotkey. */
export function currentMode(
  input: HudInput,
  /** The build plan shown (buildChoice()), when the caller has it already. */
  choice: BuildChoice | null = buildChoice(input),
  /** The outfitting visit (buildVisit()), when the caller has it already. */
  visit: BuildVisit | null = buildVisit(input, choice),
): HudModeId | "off" | null {
  return modeNow(input, choice, visit).mode;
}

/** The mode now (currentMode()), and what chose it: the journal, the activity note or the hotkey. */
export function modeNow(
  input: HudInput,
  choice: BuildChoice | null,
  visit: BuildVisit | null,
): { mode: HudModeId | "off" | null; by: "journal" | "note" | "hotkey" | null } {
  if (input.hotkey?.mode === "off") return { mode: "off", by: "hotkey" };
  const j = input.journal;
  // Expired on the panel's clock, and a stack whose missions all expired is not open.
  const groups = j ? liveMassacre(massacre(j.missions, j.events, input.now).groups) : [];
  const minedAboard =
    j && input.settings.modes.mining
      ? minedWaiting(j.cargo, j.events, input.now, input.settings.mining)
      : false;
  // A run the panel can show: with the mode off, or nothing to place, taking one changes nothing.
  const runActive = j && input.settings.modes.passenger ? drops(j.missions).length > 0 : false;
  // The same for trade: a trade stop to do, or cargo to trade aboard.
  const tradeStops = input.settings.modes.trade ? tradeTodo(input.plan) : [];
  const missions = j ? missionsNow(j, input.plan) : NO_MISSIONS;
  // Replayed only with trade on; kept for the same journal, so journalMode() reuses it.
  const aboard =
    !!j && input.settings.modes.trade && tradeCargo(j.cargo, tradeJournal(j.events, missions));
  const trade = {
    active: tradeStops.length > 0 || aboard,
    aboard,
    ...missions,
    stops: tradeStops.map((i) => input.plan!.stops[i]!),
  };
  const build =
    j && input.settings.modes.build
      ? buildNow({ note: input.plan, plans: input.buildPlans ?? [], journal: j }, choice, visit)
      : undefined;
  const fromJournal = j
    ? journalMode(
        j.events,
        groups.length > 0,
        minedAboard,
        (m) => input.settings.modes[m],
        runActive,
        trade,
        build,
      )
    : null;
  const m = noteMode(input.activity?.kind);
  // A note for a mode that is off, a missions or hauling note with no run to show, a trading note
  // with no trade stop to do, or a massacre note with no live stack, would leave the panel empty:
  // the journal's mode shows instead.
  const fromNote =
    m &&
    input.activity &&
    input.settings.modes[m] &&
    !(m === "passenger" && !runActive) &&
    // A trading note shows the panel only with a trade plan to follow.
    !(m === "trade" && !tradeStops.length) &&
    // An engineering note shows the panel only with a build plan that has something to show.
    !(m === "build" && !(isBuildPlan(input.plan) && build?.active)) &&
    // With the journal read: before then there is no stack to judge by.
    !(m === "massacre" && j && !groups.length)
      ? { mode: m, at: Date.parse(input.activity.updated_at) }
      : null;
  // journalMode skips modes that are off itself, so the run or an older mode still shows.
  const best = pickMode(fromJournal, fromNote, input.hotkey);
  const chosen = best?.mode ?? null;
  const by = !best
    ? null
    : best === fromJournal
      ? "journal"
      : best === fromNote
        ? "note"
        : "hotkey";
  if (chosen && chosen !== "off" && !input.settings.modes[chosen]) return { mode: null, by: null };
  return { mode: chosen, by };
}

function panelFor(
  mode: HudModeId,
  input: HudInput,
  choice: BuildChoice | null,
  visit: BuildVisit | null,
): PanelView | null {
  const j = input.journal;
  if (!j || mode === "route") return null;
  if (mode === "massacre")
    return massacrePanel(
      massacre(j.missions, j.events, input.now).groups,
      input.now,
      input.settings.massacre,
    );
  if (mode === "passenger") {
    return passengerPanel({
      missions: j.missions,
      events: j.events,
      plan: input.plan,
      now: input.now,
    });
  }
  if (mode === "trade") {
    return tradePanel({
      plan: input.plan,
      events: j.events,
      cargo: j.cargo,
      capacity: j.ship.cargo_capacity,
      location: j.location,
      market: input.market ?? null,
      missions: j.missions,
      now: input.now,
      missionsNow: missionsNow(j, input.plan),
      nav: input.nav,
    });
  }
  if (mode === "build") {
    // With no plan with work here, this docking's outfitting.
    if (visit) return visitPanel({ visit, events: j.events });
    return choice
      ? buildPanel({
          choice,
          journal: j,
          nav: input.nav,
          outfitting: input.outfitting ?? null,
          balance: input.status?.balance ?? null,
          settings: input.settings.build,
        })
      : null;
  }
  const system = j.location.system;
  if (mode === "mining") {
    return miningPanel({
      system,
      state: miningState(j.events, input.now, input.status?.body ?? null),
      events: j.events,
      cargo: j.cargo,
      capacity: j.ship.cargo_capacity,
      shipType: j.ship.type,
      carrier: carrierState(j.events, input.now),
      settings: input.settings.mining,
      now: input.now,
      sell: input.sell,
    });
  }
  const address = system ? systemAddress(j.events, system) : null;
  if (address === null) return null;
  const totals = explorationTotals(j.events, input.now);
  const bio = exobiology(j.events, address, { system }).bodies;
  const x = exploration(j.events, address);
  if (mode === "exobiology") {
    const s = input.status;
    // The body the ship is near, else the body of the newest sample in this system.
    const near = s?.body ? bio.find((b) => b.body.toLowerCase() === s.body!.toLowerCase()) : null;
    const lastSample = j.events.findLast(
      (e) => e.event === "ScanOrganic" && e.SystemAddress === address,
    );
    const body = near ?? bio.find((b) => b.body_id === lastSample?.Body) ?? null;
    if (body) {
      const here =
        s && s.latitude !== null && s.longitude !== null && s.radius !== null
          ? { latitude: s.latitude, longitude: s.longitude, radius: s.radius }
          : null;
      return exobiologyPanel({
        system,
        address,
        body,
        samples: input.samples,
        here,
        totals,
        footfall: wasFootfalled(j.events, address, body.body_id),
        knownSignals: knownSignals(input.known, body.body_id),
        // Other planets worth a visit after this one.
        highlights: [
          ...highlightRows(system, x, input.known),
          ...bioRows({
            system,
            address,
            events: j.events,
            exploration: x,
            bio: bio.filter((b) => b.body_id !== body.body_id),
            known: input.known?.filter((k) => k.bodyId !== body.body_id) ?? null,
            bioMin: input.settings.bioMin,
          }),
        ],
      });
    }
  }
  return explorationPanel({
    system,
    exploration: x,
    bio,
    totals,
    valuableMin: input.settings.valuableMin,
    bioMin: input.settings.bioMin,
    known: input.known,
    address,
    events: j.events,
  });
}

/**
 * The modes about where the ship is: bookmark rows show under their panels, or on their own
 * when the mode has nothing to show. Route mode has no panel, so they show on their own there.
 * The other modes, such as massacre, mining and passenger, have nothing to do with places on a
 * body, and a new mode is left out until it is added here.
 */
const SURFACE_MODES: ReadonlySet<PanelView["mode"]> = new Set<PanelView["mode"]>([
  "exploration",
  "exobiology",
  "route",
]);

/**
 * The system's exobiology, for what bio bookmarks still have to sample; read only when the
 * system has one.
 */
function bookmarkBio(input: HudInput, system: string | null): ExobiologyBody[] | null {
  const j = input.journal;
  const plan = input.bookmarks;
  if (!j || !system || !plan) return null;
  const bio = plan.stops.some(
    (b) => b.status === "todo" && b.kind === "exobiology" && same(b.system, system),
  );
  if (!bio) {
    // Not kept past the system: the old journal can be let go.
    bioMemo = null;
    return null;
  }
  // The panel redraws far more often than the journal changes: kept for the same events.
  if (bioMemo?.events === j.events && bioMemo.system === system) return bioMemo.bodies;
  const address = systemAddress(j.events, system);
  const bodies = address === null ? null : exobiology(j.events, address, { system }).bodies;
  bioMemo = { events: j.events, system, bodies };
  return bodies;
}
let bioMemo: { events: unknown[]; system: string; bodies: ExobiologyBody[] | null } | null = null;

export function buildHud(input: HudInput, moving: string | null): HudView {
  const s = input.settings;
  const base = {
    moving,
    fontSize: s.fontSize,
    backgroundOpacity: s.backgroundOpacity,
    width: s.width,
    look: input.look ?? {},
  };
  // The build plan to show, chosen once for the mode, the panel and the route keys.
  const choice = buildChoice(input);
  const found = buildVisit(input, choice);
  const { mode, by } = modeNow(input, choice, found);
  if (mode === "off") return { ...base, mode, panel: null, route: null };
  // The visit shows when its own events chose the mode. Build mode asked for by the hotkey or the
  // activity note shows the plan instead, while it has an action to do.
  const asked = by === "hotkey" || by === "note";
  const visit = found && !(asked && choice?.judged.actions.some((x) => !x.done)) ? found : null;
  let panel = mode ? panelFor(mode, input, choice, visit) : null;
  // Bookmarks in this system, from the bookmarks plan.
  const system = input.journal?.location.system ?? null;
  const marks = !s.bookmarks
    ? []
    : bookmarkRows({
        plan: input.bookmarks ?? null,
        system,
        status: input.status,
        bio: bookmarkBio(input, system),
        known: input.known,
      });
  // Under the panels about where the ship is. On their own when no panel shows, with no mode or
  // in one of those modes.
  const surface = panel ? SURFACE_MODES.has(panel.mode) : !mode || SURFACE_MODES.has(mode);
  if (marks.length && surface) {
    panel = panel
      ? { ...panel, rows: [...panel.rows, ...marks] }
      : { mode: "bookmarks", title: "BOOKMARKS", rows: marks, footer: [] };
  }
  // A plan of only trade stops: the trade panel already shows them, the jumps left and how far
  // through it you are. A fuel or mission stop still shows in the route rows.
  // Only while a trade stop is to do and the plotted route, if any, leads to the panel's stops: a
  // route elsewhere (a fuel stop, home) shows below with its jumps.
  const tradePlan =
    panel?.mode === "trade" &&
    isTradePlan(input.plan) &&
    input.plan.stops.every((x) => x.kind === "trade") &&
    tradeTodo(input.plan).length > 0 &&
    navLeadsTo(input.plan, input.nav, system) !== "other";
  // The build panel is the route: its stops are not repeated below. The plan it shows leads the
  // route keys and the arrival copy, which follow the note's plan otherwise.
  // The outfitting visit is not a plan: the route rows show under it as under other panels.
  const shown = panel?.mode === "build" && !visit ? choice : null;
  const follow =
    shown && (shown.plan.id !== input.plan?.id || shown.current !== currentStop(shown.plan))
      ? { planId: shown.plan.id, stop: shown.current }
      : undefined;
  const route =
    s.modes.route && !tradePlan && !shown
      ? routeRows({
          plan: input.plan,
          nav: input.nav,
          system: input.journal?.location.system ?? null,
        })
      : null;
  return { ...base, mode, panel, route, ...(follow ? { follow } : {}) };
}
