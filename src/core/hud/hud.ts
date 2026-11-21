import {
  exobiology,
  exploration,
  massacre,
  systemAddress,
  type Activity,
  type JournalEvent,
  type JournalState,
  type Plan,
} from "ed-mcp/journal";
import type { HudModeId, Settings } from "../settings.js";
import type { KnownBody } from "./known.js";
import { carrierState, miningPanel, miningState, minedWaiting } from "./mining.js";
import type { SellLookup, SellQuery } from "./sell.js";
import { journalMode, noteMode, pickMode, type Choice } from "./mode.js";
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
}

export interface ShipStatus {
  body: string | null;
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
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
}

/** The mode now: off by hotkey, else the newest of the journal, the note and the hotkey. */
export function currentMode(input: HudInput): HudModeId | "off" | null {
  if (input.hotkey?.mode === "off") return "off";
  const j = input.journal;
  const groups = j ? massacre(j.missions, j.events).groups : [];
  const minedAboard = j ? minedWaiting(j.cargo, j.events, input.now, input.settings.mining) : false;
  const fromJournal = j ? journalMode(j.events, groups.length > 0, minedAboard) : null;
  const m = noteMode(input.activity?.kind);
  const fromNote =
    m && input.activity ? { mode: m, at: Date.parse(input.activity.updated_at) } : null;
  const chosen = pickMode(fromJournal, fromNote, input.hotkey)?.mode ?? null;
  if (chosen && chosen !== "off" && !input.settings.modes[chosen]) return null;
  return chosen;
}

function panelFor(mode: HudModeId, input: HudInput): PanelView | null {
  const j = input.journal;
  if (!j || mode === "route") return null;
  if (mode === "massacre") return massacrePanel(massacre(j.missions, j.events).groups, input.now);
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
  const totals = explorationTotals(j.events);
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

export function buildHud(input: HudInput, moving: string | null): HudView {
  const s = input.settings;
  const base = {
    moving,
    fontSize: s.fontSize,
    backgroundOpacity: s.backgroundOpacity,
    width: s.width,
  };
  const mode = currentMode(input);
  if (mode === "off") return { ...base, mode, panel: null, route: null };
  const panel = mode ? panelFor(mode, input) : null;
  const route = s.modes.route
    ? routeRows({
        plan: input.plan,
        nav: input.nav,
        system: input.journal?.location.system ?? null,
      })
    : null;
  return { ...base, mode, panel, route };
}
