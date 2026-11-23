import type { JournalEvent, Mission, Plan } from "ed-mcp/journal";
import { credits, timeLeft, todoStops, type HudRow, type PanelView } from "./panels.js";

type Obj = Record<string, unknown>;

/**
 * Missions that carry people or goods to a station: what the passenger panel lists. Goods need a
 * destination: source, collect and mining missions have a commodity and count but none.
 */
export const isRun = (m: Mission) =>
  m.passengers != null ||
  (m.commodity != null && m.count != null && m.kill_count == null && m.destination_system != null);

// Berths by cabin size and class (1 economy, 2 business, 3 first, 4 luxury).
const BERTHS: Record<string, number> = {
  "2_1": 2,
  "3_1": 4,
  "3_2": 3,
  "4_1": 8,
  "4_2": 6,
  "4_3": 3,
  "5_1": 16,
  "5_2": 10,
  "5_3": 6,
  "5_4": 4,
  "6_1": 32,
  "6_2": 16,
  "6_3": 12,
  "6_4": 8,
};

/** The berths in the ship's passenger cabins, from the newest Loadout; null with no Loadout. */
export function berths(events: JournalEvent[]): number | null {
  const loadout = events.findLast((e) => e.event === "Loadout");
  if (!loadout || !Array.isArray(loadout.Modules)) return null;
  let n = 0;
  for (const m of loadout.Modules as Obj[]) {
    const r = /^int_passengercabin_size(\d)_class(\d)$/i.exec(String(m?.Item ?? ""));
    if (r) n += BERTHS[`${r[1]}_${r[2]}`] ?? 0;
  }
  return n;
}

/** Missions grouped where they are handed over: the destination, or the giver once complete. */
export interface Drop {
  system: string;
  station: string | null;
  missions: Mission[];
  /** All complete: only the reward to collect. */
  handIn: boolean;
}

const placeKey = (system: string, station: string | null) =>
  `${system.toLowerCase()}|${(station ?? "").toLowerCase()}`;

export function drops(missions: Mission[]): Drop[] {
  const by = new Map<string, Drop>();
  for (const m of missions.filter(isRun)) {
    const complete = m.status === "complete";
    const system = complete ? m.origin_system : m.destination_system;
    const station = complete ? m.origin_station : m.destination_station;
    if (!system) continue;
    const key = placeKey(system, station);
    const d = by.get(key) ?? { system, station, missions: [], handIn: true };
    d.missions.push(m);
    d.handIn &&= complete;
    by.set(key, d);
  }
  return [...by.values()];
}

type Stop = Plan["stops"][number];

/**
 * The missions a stop serves: its stop actions' (complete_mission, deliver_cargo, ...), and the
 * missions list a plan saved before ed-mcp wrote actions has. Null when it names none.
 */
function stopMissions(s: Stop): number[] | null {
  const fromActions = (s.actions ?? []).flatMap((a) =>
    a.mission_id !== undefined ? [a.mission_id] : [],
  );
  if (!Array.isArray(s.missions) && !fromActions.length) return null;
  return [...(s.missions ?? []), ...fromActions];
}

/**
 * A stop of a mission or delivery route: kind mission, hand_in or trade, or one that names the
 * missions it serves. Another plan's stops (exobiology, say) are not about these missions.
 */
const isMissionStop = (s: Stop) =>
  s.kind === "mission" || s.kind === "hand_in" || s.kind === "trade" || stopMissions(s) !== null;

/**
 * Mission IDs the plan's stops serve, done stops too; null when the plan does not say. A mission
 * outside it was taken after the route: new.
 */
function planned(plan: Plan | null): Set<number> | null {
  if (!plan) return null;
  const named = plan.stops.map(stopMissions);
  if (named.every((m) => m === null)) return null;
  // Every stop, done ones too: the route key marks a stop done while its mission is still open,
  // and that mission is in the route, not new.
  return new Set(named.flatMap((m) => m ?? []));
}

/**
 * Goods as the game names them. ed-mcp keeps the localised name; with none it has the journal
 * symbol, "$PowerGenerators_Name;", which reads as "Power Generators".
 */
export function goodsName(commodity: string): string {
  if (!commodity.startsWith("$")) return commodity;
  const words = commodity
    .replace(/^\$|_name;$/gi, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A mission expiring this soon is shown in amber. */
const SOON_MS = 2 * 3_600_000;

export function passengerPanel(input: {
  missions: Mission[];
  events: JournalEvent[];
  plan: Plan | null;
  now: number;
}): PanelView | null {
  const all = drops(input.missions);
  if (!all.length) return null;
  // In the order the route flies the plan's stops (visitOrder, as the route rows use), else the
  // soonest expiry first.
  const order = new Map<string, number>();
  for (const [rank, s] of todoStops(input.plan).entries()) {
    if (!isMissionStop(s)) continue;
    const k = placeKey(s.system, s.station ?? null);
    if (!order.has(k)) order.set(k, rank);
  }
  const expiry = (d: Drop) =>
    Math.min(
      ...d.missions
        .filter((m) => m.expires)
        .map((m) => Date.parse(m.expires!))
        .filter((t) => !Number.isNaN(t)),
      Infinity,
    );
  // A stop with no station stands for every station in its system.
  const rank = (d: Drop) =>
    Math.min(
      order.get(placeKey(d.system, d.station)) ?? Infinity,
      order.get(placeKey(d.system, null)) ?? Infinity,
    );
  all.sort((a, b) => rank(a) - rank(b) || expiry(a) - expiry(b));

  const rows: HudRow[] = all.map((d) => {
    const active = d.missions.filter((m) => m.status === "active");
    // Passengers on a mission redirected back to its origin (complete in ed-mcp) are still aboard
    // until it is handed in there; ed-mcp drops a mission once it is completed.
    const aboard = d.missions;
    const pax = aboard.reduce((n, m) => n + (m.passengers ?? 0), 0);
    const vip = aboard.filter((m) => m.vips).reduce((n, m) => n + (m.passengers ?? 0), 0);
    const wanted = aboard.filter((m) => m.wanted).reduce((n, m) => n + (m.passengers ?? 0), 0);
    const goods = active
      .filter((m) => m.passengers == null)
      .map((m) => `${m.count} t ${goodsName(m.commodity!)}`);
    const flags = [vip ? `${vip} VIP` : null, wanted ? `${wanted} wanted` : null].filter(Boolean);
    const what = [
      pax ? `${pax} pax${flags.length ? ` (${flags.join(", ")})` : ""}` : null,
      ...goods,
      d.missions.length > active.length ? "hand in" : null,
    ].filter(Boolean);
    const soonest = expiry(d);
    const left = soonest === Infinity ? null : soonest - input.now;
    return {
      text: d.station ? `${d.system} · ${d.station}` : d.system,
      right: [what.join(" · "), left !== null ? timeLeft(left) : null].filter(Boolean).join("  "),
      tone: d.handIn ? "dim" : left !== null && left < SOON_MS ? "warn" : undefined,
    };
  });

  const active = input.missions.filter((m) => isRun(m) && m.status === "active");
  const ids = planned(input.plan);
  if (ids) {
    const fresh = active.filter((m) => !ids.has(m.id)).length;
    if (fresh) {
      rows.push({
        text: `Route stale: ${fresh} new mission${fresh === 1 ? "" : "s"}. Ask Claude to re-route`,
        tone: "warn",
      });
    }
  } else if (all.length > 1 && !input.plan?.stops.some(isMissionStop)) {
    // A plan with mission stops is a route, even when its stops do not list their missions (one
    // planned by hand), so it cannot say whether the route is stale.
    rows.push({ text: "No mission route: ask Claude to plan one", tone: "dim" });
  }

  // Berths used: every open passenger mission's passengers, those to hand in at the origin too.
  const aboard = input.missions.filter(isRun).reduce((n, m) => n + (m.passengers ?? 0), 0);
  const reward = input.missions.filter(isRun).reduce((n, m) => n + (m.reward ?? 0), 0);
  const cabins = berths(input.events);
  const ready = input.missions.filter((m) => isRun(m) && m.status === "complete").length;
  const open = input.missions.filter(isRun).length;
  // Every open mission ready to hand in: the run is done.
  const done = open > 0 && ready === open;
  return {
    mode: "passenger",
    // Passengers still to hand in make it a passenger run too.
    title: all.some((d) => d.missions.some((m) => m.passengers != null))
      ? "PASSENGERS"
      : "DELIVERIES",
    right: [
      aboard || cabins ? `${aboard}${cabins ? `/${cabins}` : ""} berths` : null,
      reward ? credits(reward) : null,
      done ? "✓" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    ...(done ? { tone: "good" as const } : {}),
    rows,
    footer: [
      [
        // Every open mission, those to hand in too: "0 missions · 2 to hand in" read as none left.
        `${open} mission${open === 1 ? "" : "s"}`,
        ready ? `${ready} to hand in` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
  };
}
