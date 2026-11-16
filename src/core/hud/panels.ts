import {
  bodyValue,
  genusName,
  genusValue,
  predictSpecies,
  scanConditions,
  type BioConditions,
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
import { isHighlight, type KnownBody } from "./known.js";

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
/** A value that may or may not get a first-discovery or first-footfall bonus. */
export function creditRange(lo: number, hi: number): string {
  if (hi <= lo) return credits(lo);
  if (lo >= 1e6 && hi < 1e9) return `${(lo / 1e6).toFixed(1)}–${credits(hi)}`;
  return `${credits(lo)}–${credits(hi)}`;
}

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

/** Universal Cartographics does not buy data for systems this close to the station. */
const SELL_MIN_LY = 20;

/**
 * Unsold data since the last sale or death, and this game session's counts. A sale sells all
 * the data it can, so it clears what it lists, and also every system it could have sold but did
 * not: only systems within 20 ly of the station stay unsold.
 */
export function explorationTotals(events: JournalEvent[]): ExplorationTotals {
  const scans = new Map<
    string,
    { system: string | null; address: number | null; scan: Obj; mapped: boolean }
  >();
  const starPos = new Map<number, number[]>();
  // Planets nobody had set foot on, where analysed species pay the first-footfall bonus.
  const untrodden = new Set<string>();
  let here: number | null = null;
  let bio = 0;
  let bioCount = 0;
  const session = { systems: 0, scanned: 0, mapped: 0, firstDiscoveries: 0 };
  for (const e of events) {
    const key = `${num(e.SystemAddress)}|${num(e.BodyID)}`;
    const address = num(e.SystemAddress);
    if (address !== null && Array.isArray(e.StarPos) && e.StarPos.length === 3) {
      starPos.set(address, e.StarPos as number[]);
    }
    switch (e.event) {
      case "LoadGame":
        session.systems = session.scanned = session.mapped = session.firstDiscoveries = 0;
        break;
      case "FSDJump":
        session.systems++;
        here = address;
        break;
      case "Location":
      case "CarrierJump":
        here = address;
        break;
      case "Scan": {
        if (e.WasFootfalled === false) untrodden.add(key);
        else if (e.WasFootfalled === true) untrodden.delete(key);
        const prev = scans.get(key);
        scans.set(key, {
          system: str(e.StarSystem),
          address,
          scan: e,
          mapped: prev?.mapped ?? false,
        });
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
        const station = here !== null ? starPos.get(here) : undefined;
        const near = (a: number | null) => {
          const p = a !== null ? starPos.get(a) : undefined;
          // With no position to compare, keep the data rather than guess.
          if (!station || !p) return true;
          return (
            Math.hypot(p[0]! - station[0]!, p[1]! - station[1]!, p[2]! - station[2]!) <= SELL_MIN_LY
          );
        };
        for (const [k, s] of scans) {
          if ((s.system && sold.has(s.system.toLowerCase())) || !near(s.address)) scans.delete(k);
        }
        break;
      }
      case "ScanOrganic":
        if (e.ScanType === "Analyse") {
          const v = speciesValue(String(e.Species ?? "")) ?? 0;
          const first = untrodden.has(`${address}|${num(e.Body)}`);
          bio += first ? v * FOOTFALL_BONUS : v;
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

/**
 * Earth-like, water and ammonia worlds and terraformables in the system, from the scans and
 * from Spansh: green once scanned, grey before, nearest first.
 */
export function highlightRows(
  system: string | null,
  x: Exploration | null,
  known: KnownBody[] | null,
): HudRow[] {
  const scanned = new Map((x?.bodies ?? []).map((b) => [b.body_id, b]));
  type Item = {
    name: string;
    type: string | null;
    tf: boolean;
    ls: number | null;
    id: number;
    mass?: number | null;
  };
  const items = new Map<number, Item>();
  for (const k of known ?? []) {
    if (!isHighlight(k.type, k.terraformable)) continue;
    items.set(k.bodyId, {
      name: k.name,
      type: k.type,
      tf: k.terraformable,
      ls: k.distance_ls,
      id: k.bodyId,
      mass: k.massEM,
    });
  }
  for (const b of x?.bodies ?? []) {
    if (!isHighlight(b.type, b.terraformable)) continue;
    items.set(b.body_id, {
      name: b.body,
      type: b.type,
      tf: b.terraformable,
      ls: b.distance_ls,
      id: b.body_id,
    });
  }
  return [...items.values()]
    .sort((a, b) => (a.ls ?? Infinity) - (b.ls ?? Infinity))
    .map((i) => {
      const b = scanned.get(i.id);
      const value = b ? (b.value_mapped ?? b.value_scanned) : null;
      const state = !b ? "not scanned" : b.mapped_by_you ? "mapped ✓" : "map";
      // Before the scan, a planet Spansh lists may still pay first-discovery and first-mapped
      // bonuses (data nobody has handed in), so its mapped value is a range.
      const scan = {
        PlanetClass: i.type,
        MassEM: i.mass,
        TerraformState: i.tf ? "Terraformable" : "",
      };
      const estimate =
        !b && i.mass != null
          ? creditRange(
              bodyValue(scan, { mapped: true, efficient: true }) ?? 0,
              bodyValue(scan, {
                mapped: true,
                efficient: true,
                firstDiscovery: true,
                firstMapped: true,
              }) ?? 0,
            )
          : null;
      return {
        text: `${b?.was_discovered === false ? "★ " : ""}${shortBody(i.name, system)}  ${shortType(i.type)}${i.tf && !/earthlike/i.test(i.type ?? "") ? " tf" : ""}`,
        right: [
          i.ls !== null ? `${Math.round(i.ls).toLocaleString("en-US")} ls` : null,
          value ? credits(value) : estimate ? `~${estimate}` : null,
          state,
        ]
          .filter(Boolean)
          .join("  "),
        tone: b ? "good" : "dim",
      };
    });
}

/** What one genus on a planet is likely worth, and what to call it. */
interface GenusGuess {
  /** The species when sampled or confidently predicted, else the genus. */
  label: string;
  likely: number;
  min: number;
  max: number;
}

/** A species confidently predicted is named; below this likelihood the genus is shown. */
const NAME_LIKELIHOOD = 0.6;

function guessGenus(
  genus: string,
  sampled: ExobiologyBody["species"][number] | undefined,
  conditions: BioConditions | null,
): GenusGuess | null {
  if (sampled?.value != null) {
    const v = sampled.value;
    return { label: sampled.species, likely: v, min: v, max: v };
  }
  const p = conditions ? predictSpecies(genus, conditions) : [];
  if (p.length) {
    const values = p.map((x) => x.value);
    return {
      label: p[0]!.likelihood >= NAME_LIKELIHOOD ? `${p[0]!.name}?` : genus,
      likely: p[0]!.value,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }
  const v = genusValue(genus);
  return v ? { label: genus, likely: v.min, min: v.min, max: v.max } : null;
}

/** Vista Genomics pays five times as much for species from a planet nobody has set foot on. */
export const FOOTFALL_BONUS = 5;

/** Whether someone has set foot on the planet, from its newest Scan; null before the scan. */
export function wasFootfalled(
  events: JournalEvent[],
  address: number | null,
  bodyId: number,
): boolean | null {
  let v: boolean | null = null;
  for (const e of events) {
    if (e.event !== "Scan" || e.SystemAddress !== address || e.BodyID !== bodyId) continue;
    if (typeof e.WasFootfalled === "boolean") v = e.WasFootfalled;
  }
  return v;
}

/**
 * Planets with biological signals, from the scans and from Spansh, worth at least `bioMin`:
 * by the likely species of each genus where the planet's conditions predict them, else by the
 * least each genus can be worth. Grey before the scan, plain after, green with ✓ once every
 * species is analysed. A planet whose genera are not known yet is listed, since it may be worth it.
 */
export function bioRows(input: {
  system: string | null;
  address: number | null;
  events: JournalEvent[];
  exploration: Exploration | null;
  bio: ExobiologyBody[];
  known: KnownBody[] | null;
  bioMin: number;
}): HudRow[] {
  const { system, address } = input;
  const scanned = new Map((input.exploration?.bodies ?? []).map((b) => [b.body_id, b]));
  const journal = new Map(input.bio.map((b) => [b.body_id, b]));
  const known = new Map((input.known ?? []).map((k) => [k.bodyId, k]));
  const ids = new Set([
    ...[...known.values()].filter((k) => k.bioSignals > 0).map((k) => k.bodyId),
    ...input.bio.filter((b) => b.bio_signals || b.genera.length).map((b) => b.body_id),
  ]);
  type Item = HudRow & { worth: number; ls: number };
  const items: Item[] = [];
  for (const id of ids) {
    const j = journal.get(id);
    const k = known.get(id);
    const x = scanned.get(id);
    const conditions =
      (address !== null ? scanConditions(input.events, address, id) : null) ??
      (k ? { ...k.conditions, systemAddress: address } : null);
    const genera = j?.genera.length ? j.genera : (k?.genera ?? []).map((g) => genusName(g) ?? g);
    const guesses = genera.map((g) =>
      guessGenus(
        g,
        j?.species.find((s) => s.genus === g && s.analysed),
        conditions,
      ),
    );
    const known_ = guesses.every((g) => g !== null) && guesses.length > 0;
    const sum = (f: (g: GenusGuess) => number) => guesses.reduce((n, g) => n + (g ? f(g) : 0), 0);
    const footfall = wasFootfalled(input.events, address, id);
    // Unknown until the planet is scanned: Spansh lists planets nobody has landed on too.
    const bonus = footfall === false ? FOOTFALL_BONUS : 1;
    const base = known_ ? sum((g) => g.likely) : null;
    const likely = base !== null ? base * bonus : null;
    if (likely !== null && likely < input.bioMin) continue;
    const signals = j?.bio_signals ?? k?.bioSignals ?? genera.length;
    const analysed = j?.species.filter((s) => s.analysed).length ?? 0;
    const done = signals > 0 && analysed >= signals;
    const name = x?.body ?? j?.body ?? k?.name ?? String(id);
    const ls = x?.distance_ls ?? k?.distance_ls ?? null;
    const labels = guesses.map((g, i) => g?.label ?? genera[i]!);
    items.push({
      text: `${x?.was_discovered === false ? "★ " : ""}${shortBody(name, system)}  ${signals} bio${labels.length ? ` · ${labels.join(", ")}` : ""}`,
      right: [
        ls !== null ? `${Math.round(ls).toLocaleString("en-US")} ls` : null,
        likely === null
          ? "?"
          : footfall === null
            ? `~${creditRange(likely, likely * FOOTFALL_BONUS)}`
            : `~${credits(likely)}${bonus > 1 ? " ×5" : ""}`,
        done ? "✓" : analysed ? `${analysed}/${signals}` : x ? null : "not scanned",
      ]
        .filter(Boolean)
        .join("  "),
      // Green only when every species is analysed: until then the species are a guess.
      // Plain once scanned, grey before.
      tone: done ? "good" : x || analysed ? undefined : "dim",
      worth: likely ?? 0,
      ls: ls ?? Infinity,
    });
  }
  return items
    .sort((a, b) => b.worth - a.worth || a.ls - b.ls)
    .map(({ worth: _w, ls: _l, ...r }) => r);
}

export function explorationPanel(input: {
  system: string | null;
  exploration: Exploration;
  bio: ExobiologyBody[];
  totals: ExplorationTotals;
  valuableMin: number;
  bioMin?: number;
  known?: KnownBody[] | null;
  /** For predicting species from the journal's scans. */
  address?: number | null;
  events?: JournalEvent[];
}): PanelView {
  const { system, exploration: x } = input;
  type Item = HudRow & { done: boolean; value: number };
  const items: Item[] = [];
  const known = input.known ?? null;
  const highlights = highlightRows(system, x, known);
  const bio = bioRows({
    system,
    address: input.address ?? null,
    events: input.events ?? [],
    exploration: x,
    bio: input.bio,
    known,
    bioMin: input.bioMin ?? 0,
  });
  const bioIds = new Set([
    ...input.bio.map((b) => b.body_id),
    ...(known ?? []).filter((k) => k.bioSignals > 0).map((k) => k.bodyId),
  ]);
  for (const b of x.bodies) {
    if (b.type?.endsWith(" star")) continue;
    // Listed with the highlights or the bio planets instead.
    if (isHighlight(b.type, b.terraformable) || bioIds.has(b.body_id)) continue;
    const geo = b.signals.filter((s) => /geo/i.test(s.type)).reduce((n, s) => n + s.count, 0);
    const value = b.value_mapped ?? b.value_scanned ?? 0;
    if (value < input.valuableMin && !geo) continue;
    const bits = [shortType(b.type) + (b.terraformable ? " tf" : ""), geo ? `${geo} geo` : null];
    const done = b.mapped_by_you;
    items.push({
      text: `${b.was_discovered === false ? "★ " : ""}${shortBody(b.body, system)}  ${bits.filter(Boolean).join(" · ")}`,
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
  items.sort((a, b) => Number(a.done) - Number(b.done) || b.value - a.value);
  const top = [...highlights, ...bio];
  const room = Math.max(2, MAX_BODIES - top.length);
  // The journal's scans say whether anyone handed in the system's data (the arrival star is
  // scanned on the jump). Before that, a system missing from Spansh is a good sign, though
  // only a sign: not everyone uploads their scans.
  const discovered = x.bodies.some((b) => b.was_discovered === true);
  const undiscovered = !discovered && x.bodies.some((b) => b.was_discovered === false);
  const status: HudRow[] = undiscovered
    ? [{ text: "★ Undiscovered system", tone: "accent" }]
    : !discovered && known && !known.length
      ? [{ text: "★ Not on Spansh: may be undiscovered", tone: "accent" }]
      : [];
  const rows: HudRow[] = [
    ...status,
    ...top,
    ...items.slice(0, room).map(({ done: _d, value: _v, ...r }) => r),
  ];
  if (items.length > room) rows.push({ text: `+${items.length - room} more`, tone: "dim" });
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
  /** highlightRows() for the system. */
  highlights?: HudRow[];
  /** wasFootfalled() for the body: false pays the first-footfall bonus. */
  footfall?: boolean | null;
}): PanelView {
  const { body } = input;
  const bonus = input.footfall === false ? FOOTFALL_BONUS : 1;
  const rows: HudRow[] = [];
  for (const s of body.species) {
    const value = s.value !== null ? credits(s.value * bonus) : "";
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
  for (const g of body.not_started) {
    // The likely species from the planet's conditions: the best, and the next when close.
    const likely = body.likely?.find((l) => l.genus === g)?.species ?? [];
    const top = likely.filter((p, i) => i === 0 || p.likelihood >= 0.25).slice(0, 2);
    const names = top.map((p) => p.name.replace(new RegExp(`^${g} `), "")).join(" / ");
    rows.push({
      text: top.length ? `${g}  likely ${names}` : `${g}  not started`,
      right: top.length ? `~${credits(top[0]!.value * bonus)}` : undefined,
      tone: "dim",
    });
  }
  // The system's Earth-like, water and ammonia worlds stay in view while on a planet.
  if (input.highlights?.length) {
    rows.push({ text: "In system", tone: "dim" }, ...input.highlights);
  }
  return {
    mode: "exobiology",
    title: "EXOBIOLOGY",
    subtitle: shortBody(body.body, input.system),
    right: `${bonus > 1 ? "first footfall ×5 · " : ""}${body.genera.length || body.bio_signals || 0} genera`,
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

type PlanStop = Plan["stops"][number];

/**
 * Where a stop is: the station, else the body, else the system. `full` adds the system to a
 * station. A body in the same system as the stop before it drops the system name; a body name
 * that already starts with the system name is not repeated.
 */
function stopPlace(s: PlanStop, prev: PlanStop | undefined, full = false): string {
  if (s.station) return full ? `${s.station}, ${s.system}` : s.station;
  if (!s.body) return s.system;
  const sameSystem = prev?.system.toLowerCase() === s.system.toLowerCase();
  if (s.body.toLowerCase().startsWith(s.system.toLowerCase())) {
    return sameSystem ? s.body.slice(s.system.length).trim() || s.body : s.body;
  }
  return sameSystem ? s.body : `${s.system} ${s.body}`;
}

/** Jumps left on the plotted route from the current system; null when there is no route. */
export function jumpsLeft(nav: NavRoute | null, system: string | null): number | null {
  if (!nav) return null;
  const i = system ? nav.systems.findIndex((s) => s.toLowerCase() === system.toLowerCase()) : -1;
  const left = nav.systems.length - 1 - Math.max(0, i);
  return left > 0 ? left : null;
}

export interface RouteRow {
  /** current: the stop to fly to; label: what it is for; next: the stop after; more: the rest. */
  kind: "current" | "label" | "next" | "more";
  text: string;
  right?: string;
}

/** Stops shown after the current one; the rest are counted. */
const NEXT_STOPS = 1;

/**
 * The route, one stop to a row so long system names fit: the current stop with the jumps left,
 * what it is for, the next stop, and how many follow.
 */
export function routeRows(input: {
  plan: Plan | null;
  nav: NavRoute | null;
  system: string | null;
}): RouteRow[] | null {
  const jumps = jumpsLeft(input.nav, input.system);
  const right = jumps !== null ? `${jumps} jump${jumps === 1 ? "" : "s"}` : undefined;
  const withRight = (r: RouteRow): RouteRow => (right ? { ...r, right } : r);
  const plan = input.plan;
  if (plan && plan.stops.length) {
    const order = visitOrder(plan);
    const cur = order.findIndex((i) => plan.stops[i]!.status === "todo");
    if (cur >= 0) {
      const at = (k: number) => plan.stops[order[k]!]!;
      const now = at(cur);
      const rows: RouteRow[] = [
        withRight({ kind: "current", text: stopPlace(now, undefined, true) }),
      ];
      if (now.label) rows.push({ kind: "label", text: now.label });
      const last = Math.min(order.length, cur + 1 + NEXT_STOPS);
      for (let k = cur + 1; k < last; k++) {
        rows.push({ kind: "next", text: stopPlace(at(k), at(k - 1), true) });
      }
      const more = order.slice(last).filter((i) => plan.stops[i]!.status === "todo").length;
      if (more) rows.push({ kind: "more", text: `+${more} more stop${more === 1 ? "" : "s"}` });
      return rows;
    }
  }
  if (input.nav && jumps !== null) {
    return [withRight({ kind: "current", text: input.nav.systems.at(-1)! })];
  }
  return null;
}

/** The plan stop index the route keys move to: the current stop, then dir steps along. */
export function currentStop(plan: Plan): number | null {
  const order = visitOrder(plan);
  const i = order.find((j) => plan.stops[j]!.status === "todo");
  return i ?? null;
}

/** The last stop marked done before the current one, in visit order; skipped stops stay. */
export function previousStop(plan: Plan): number | null {
  const order = visitOrder(plan);
  const cur = order.findIndex((j) => plan.stops[j]!.status === "todo");
  const before = cur < 0 ? order : order.slice(0, cur);
  const i = before.findLast((j) => plan.stops[j]!.status === "done");
  return i ?? null;
}

/** The first stop to do after the current one, in visit order, in another system. */
export function nextStopAfter(plan: Plan, current: number): number | null {
  const order = visitOrder(plan);
  const here = plan.stops[current]!.system.toLowerCase();
  const i = order
    .slice(order.indexOf(current) + 1)
    .find((j) => plan.stops[j]!.status === "todo" && plan.stops[j]!.system.toLowerCase() !== here);
  return i ?? null;
}

/** Whether the player cleared the plotted route after last plotting one: NavRoute.json stays. */
export function navRouteCleared(events: JournalEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event === "NavRouteClear") return true;
    if (events[i]!.event === "NavRoute") return false;
  }
  return false;
}

/** The stops still to do, in visit order: the current stop first. */
export function todoStops(plan: Plan | null): Plan["stops"] {
  if (!plan) return [];
  return visitOrder(plan)
    .map((i) => plan.stops[i]!)
    .filter((s) => s.status === "todo");
}
