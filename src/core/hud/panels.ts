import {
  bodyValue,
  speciesValue,
  surfaceDistance,
  visitOrder,
  type ExobiologyBody,
  type Exploration,
  type JournalEvent,
  type MassacreGroup,
  type Plan,
} from "ed-mcp/journal";
import type { HudModeId } from "../settings.js";

export type Tone = "dim" | "good" | "warn" | "accent";

export interface HudRow {
  text: string;
  right?: string;
  /** 0 to 1: a progress bar under the text. */
  bar?: number;
  tone?: Tone;
}

export interface PanelView {
  mode: HudModeId;
  title: string;
  subtitle?: string;
  right?: string;
  rows: HudRow[];
  footer: string[];
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** 2.1M, 840k, 500. */
export function credits(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** 1d 4h, 3h 20m, 12m; "expired" when past. */
export function timeLeft(ms: number): string {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// ---------- Massacre ----------

export function massacrePanel(groups: MassacreGroup[], now: number): PanelView | null {
  if (!groups.length) return null;
  const rows: HudRow[] = [];
  const missions = groups.flatMap((g) => g.factions.flatMap((f) => f.missions));
  for (const g of groups) {
    rows.push({ text: g.target_faction, right: `${g.kills_left} left`, tone: "accent" });
    for (const f of g.factions) {
      const need = f.missions.reduce((n, m) => n + m.kills_required, 0);
      const got = f.missions.reduce((n, m) => n + Math.min(m.kills_counted, m.kills_required), 0);
      rows.push({
        text: f.faction,
        right: `${got}/${need}`,
        bar: need ? got / need : 1,
        tone: f.kills_left === 0 ? "good" : undefined,
      });
    }
  }
  const ready = missions.filter((m) => m.done).length;
  const expiries = missions
    .filter((m) => !m.done && m.expires)
    .map((m) => Date.parse(m.expires!))
    .filter((t) => !Number.isNaN(t));
  const footer = [
    [
      ready ? `${ready} ready to hand in` : null,
      expiries.length ? `next expires ${timeLeft(Math.min(...expiries) - now)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  ].filter(Boolean);
  const total = groups.reduce((n, g) => n + g.kills_left, 0);
  return { mode: "massacre", title: "MASSACRE", right: `${total} left`, rows, footer };
}

// ---------- Exploration ----------

const TYPES: Record<string, string> = {
  "Earthlike body": "Earth-like",
  "Water world": "Water world",
  "Ammonia world": "Ammonia world",
  "High metal content body": "HMC",
  "Metal rich body": "Metal-rich",
  "Rocky body": "Rocky",
  "Icy body": "Icy",
  "Rocky ice body": "Rocky ice",
};

function shortType(type: string | null): string {
  if (!type) return "";
  if (/gas giant/i.test(type)) return "Gas giant";
  return TYPES[type] ?? type;
}

/** The body's name without the system name: "A 3". */
export function shortBody(body: string, system: string | null): string {
  if (system && body.toLowerCase().startsWith(system.toLowerCase())) {
    return body.slice(system.length).trim() || body;
  }
  return body;
}

export interface ExplorationTotals {
  unsoldCartographic: number;
  unsoldBio: number;
  unsoldBioCount: number;
  session: { systems: number; scanned: number; mapped: number; firstDiscoveries: number };
}

/** Unsold data since the last sale or death, and this game session's counts. */
export function explorationTotals(events: JournalEvent[]): ExplorationTotals {
  const scans = new Map<string, { system: string | null; scan: Obj; mapped: boolean }>();
  let bio = 0;
  let bioCount = 0;
  const session = { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 };
  for (const e of events) {
    const key = `${num(e.SystemAddress)}|${num(e.BodyID)}`;
    switch (e.event) {
      case "LoadGame":
        session.systems = session.scanned = session.mapped = session.firstDiscoveries = 0;
        break;
      case "FSDJump":
        session.systems++;
        break;
      case "Scan": {
        const prev = scans.get(key);
        scans.set(key, { system: str(e.StarSystem), scan: e, mapped: prev?.mapped ?? false });
        if (e.ScanType === "Detailed") {
          session.scanned++;
          if (e.WasDiscovered === false) session.firstDiscoveries++;
        }
        break;
      }
      case "SAAScanComplete": {
        const s = scans.get(key);
        if (s) s.mapped = true;
        session.mapped++;
        break;
      }
      case "SellExplorationData":
      case "MultiSellExplorationData": {
        const sold = new Set(
          [
            ...(Array.isArray(e.Systems) ? e.Systems : []),
            ...(Array.isArray(e.Discovered)
              ? (e.Discovered as Obj[]).map((d) => d?.SystemName)
              : []),
          ]
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.toLowerCase()),
        );
        for (const [k, s] of scans)
          if (s.system && sold.has(s.system.toLowerCase())) scans.delete(k);
        break;
      }
      case "ScanOrganic":
        if (e.ScanType === "Analyse") {
          bio += speciesValue(String(e.Species ?? "")) ?? 0;
          bioCount++;
        }
        break;
      case "SellOrganicData":
        bio = 0;
        bioCount = 0;
        break;
      case "Died":
        scans.clear();
        bio = 0;
        bioCount = 0;
        break;
    }
  }
  let carto = 0;
  for (const s of scans.values()) {
    const firstDiscovery = s.scan.WasDiscovered === false;
    carto +=
      bodyValue(s.scan, {
        mapped: s.mapped && typeof s.scan.PlanetClass === "string",
        efficient: true,
        firstDiscovery,
        firstMapped: s.scan.WasMapped === false,
      }) ?? 0;
  }
  return { unsoldCartographic: carto, unsoldBio: bio, unsoldBioCount: bioCount, session };
}

function totalsFooter(t: ExplorationTotals): string[] {
  const unsold = [
    t.unsoldCartographic ? `${credits(t.unsoldCartographic)} cartographic` : null,
    t.unsoldBioCount ? `${t.unsoldBioCount} bio (${credits(t.unsoldBio)})` : null,
  ].filter(Boolean);
  const s = t.session;
  return [
    unsold.length ? `Unsold: ${unsold.join(" · ")}` : null,
    s.systems || s.scanned
      ? `Session: ${s.systems} jumps · ${s.scanned} scanned · ${s.mapped} mapped · ${s.firstDiscoveries} ★`
      : null,
  ].filter((x): x is string => x !== null);
}

const MAX_BODIES = 8;

export function explorationPanel(input: {
  system: string | null;
  exploration: Exploration;
  bio: ExobiologyBody[];
  totals: ExplorationTotals;
  valuableMin: number;
}): PanelView {
  const { system, exploration: x } = input;
  type Item = HudRow & { done: boolean; value: number };
  const items: Item[] = [];
  const scannedIds = new Set(x.bodies.map((b) => b.body_id));
  for (const b of x.bodies) {
    if (b.type?.endsWith(" star")) continue;
    const bio = b.signals.filter((s) => /bio/i.test(s.type)).reduce((n, s) => n + s.count, 0);
    const geo = b.signals.filter((s) => /geo/i.test(s.type)).reduce((n, s) => n + s.count, 0);
    const value = b.value_mapped ?? b.value_scanned ?? 0;
    if (value < input.valuableMin && !bio && !geo) continue;
    const bits = [
      shortType(b.type) + (b.terraformable ? " tf" : ""),
      bio ? `${bio} bio` : null,
      geo ? `${geo} geo` : null,
    ].filter(Boolean);
    const done = b.mapped_by_you;
    items.push({
      text: `${b.was_discovered === false ? "★ " : ""}${shortBody(b.body, system)}  ${bits.join(" · ")}`,
      right: [
        b.distance_ls !== null ? `${b.distance_ls.toLocaleString("en-US")} ls` : null,
        credits(value),
        done ? "✓" : "map",
      ]
        .filter(Boolean)
        .join("  "),
      tone: done ? "dim" : value >= input.valuableMin ? "accent" : undefined,
      done,
      value,
    });
  }
  // Bodies with biological signals from the FSS that have no detailed scan yet.
  for (const b of input.bio) {
    if (scannedIds.has(b.body_id) || !b.bio_signals) continue;
    items.push({
      text: `${shortBody(b.body, system)}  ${b.bio_signals} bio`,
      right: "scan",
      done: false,
      value: 0,
    });
  }
  items.sort((a, b) => Number(a.done) - Number(b.done) || b.value - a.value);
  const rows: HudRow[] = items.slice(0, MAX_BODIES).map(({ done: _d, value: _v, ...r }) => r);
  if (items.length > MAX_BODIES)
    rows.push({ text: `+${items.length - MAX_BODIES} more`, tone: "dim" });
  if (!rows.length) rows.push({ text: "Nothing valuable scanned yet", tone: "dim" });
  const d = x.discovery;
  const right =
    d.body_count !== null ? `${x.scanned}/${d.body_count} bodies` : `${x.scanned} scanned`;
  return {
    mode: "exploration",
    title: "EXPLORE",
    subtitle: system ?? undefined,
    right: d.all_bodies_found ? `${right} ✓` : right,
    rows,
    footer: totalsFooter(input.totals),
  };
}

// ---------- Exobiology ----------

export interface Point {
  latitude: number;
  longitude: number;
}

/** The key of a species on a body, for the sample positions. */
export const sampleKey = (bodyId: number, species: string) => `${bodyId}|${species}`;

export function exobiologyPanel(input: {
  system: string | null;
  body: ExobiologyBody;
  /** Where each species was sampled, by sampleKey(), as seen live. */
  samples: Map<string, Point[]>;
  /** The player's position on the body now, and its radius in metres. */
  here: (Point & { radius: number }) | null;
  totals: ExplorationTotals;
}): PanelView {
  const { body } = input;
  const rows: HudRow[] = [];
  for (const s of body.species) {
    const value = s.value !== null ? credits(s.value) : "";
    if (s.analysed) {
      rows.push({ text: s.species, right: `✓  ${value}`, tone: "good" });
      continue;
    }
    if (s.abandoned) {
      rows.push({ text: s.species, right: `restart  ${value}`, tone: "warn" });
      continue;
    }
    rows.push({ text: s.species, right: `${s.stage}  ${value}`, tone: "accent" });
    const points = input.samples.get(sampleKey(body.body_id, s.species)) ?? [];
    if (input.here && points.length && s.colony_m !== null) {
      const here = input.here;
      const d = Math.min(...points.map((p) => surfaceDistance(p, here, here.radius)));
      rows.push({
        text: `  ↔ ${Math.round(d)} m / ${s.colony_m} m`,
        tone: d >= s.colony_m ? "good" : "warn",
        bar: Math.min(1, d / s.colony_m),
      });
    }
  }
  for (const g of body.not_started) rows.push({ text: `${g}  not started`, tone: "dim" });
  return {
    mode: "exobiology",
    title: "EXOBIOLOGY",
    subtitle: shortBody(body.body, input.system),
    right: `${body.genera.length || body.bio_signals || 0} genera`,
    rows,
    footer: totalsFooter(input.totals).slice(0, 1),
  };
}

// ---------- Route ----------

export interface NavRoute {
  /** The plotted systems, from the one the route was plotted in to the destination. */
  systems: string[];
}

export function parseNavRoute(text: string): NavRoute | null {
  try {
    const j = JSON.parse(text) as { Route?: unknown };
    if (!Array.isArray(j.Route)) return null;
    const systems = (j.Route as Obj[]).map((r) => str(r?.StarSystem)).filter((s) => s !== null);
    return systems.length > 1 ? { systems } : null;
  } catch {
    return null;
  }
}

function stopName(s: Plan["stops"][number]): string {
  if (s.label) return s.label;
  if (s.station) return s.station;
  if (s.body) return `${s.system} ${s.body}`;
  return s.system;
}

/** Jumps left on the plotted route from the current system; null when there is no route. */
export function jumpsLeft(nav: NavRoute | null, system: string | null): number | null {
  if (!nav) return null;
  const i = system ? nav.systems.findIndex((s) => s.toLowerCase() === system.toLowerCase()) : -1;
  const left = nav.systems.length - 1 - Math.max(0, i);
  return left > 0 ? left : null;
}

/** One line: ✓ previous ▸ ● current · 3 jumps ▸ next ▸ … */
export function routeLine(input: {
  plan: Plan | null;
  nav: NavRoute | null;
  system: string | null;
}): string | null {
  const jumps = jumpsLeft(input.nav, input.system);
  const jumpText = jumps !== null ? ` · ${jumps} jump${jumps === 1 ? "" : "s"}` : "";
  const plan = input.plan;
  if (plan && plan.stops.length) {
    const order = visitOrder(plan);
    const cur = order.findIndex((i) => plan.stops[i]!.status === "todo");
    if (cur >= 0) {
      const parts: string[] = [];
      if (cur > 0) parts.push(`✓ ${stopName(plan.stops[order[cur - 1]!]!)}`);
      parts.push(`● ${stopName(plan.stops[order[cur]!]!)}${jumpText}`);
      for (const i of order.slice(cur + 1, cur + 4)) parts.push(stopName(plan.stops[i]!));
      if (order.length > cur + 4) parts.push("…");
      return parts.join(" ▸ ");
    }
  }
  if (input.nav && jumps !== null) return `● ${input.nav.systems.at(-1)}${jumpText}`;
  return null;
}

/** The plan stop index the route keys move to: the current stop, then dir steps along. */
export function currentStop(plan: Plan): number | null {
  const order = visitOrder(plan);
  const i = order.find((j) => plan.stops[j]!.status === "todo");
  return i ?? null;
}
