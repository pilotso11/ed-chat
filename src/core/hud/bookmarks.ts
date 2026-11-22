import {
  exobiology,
  surfaceDistance,
  systemAddress,
  type ExobiologyBody,
  type JournalEvent,
  type JournalState,
  type Plan,
  type Stop,
} from "ed-mcp/journal";
import type { ShipStatus } from "./hud.js";
import { same } from "./json.js";
import type { KnownBody } from "./known.js";
import { bioProgress, knownSignals, shortBody, type HudRow } from "./panels.js";

/** The plan that holds surface bookmarks, in ed-mcp's plan store so Claude sees them too. */
export const BOOKMARKS_PLAN = "bookmarks";

export interface Position {
  latitude: number;
  longitude: number;
}

/**
 * A body name to compare by, in this system: "6 k" and "Wredguia MN-J d9-9 6 k" are the same
 * body, since Claude may write a stop's body either way.
 */
const bodyKey = (body: string, system: string) => shortBody(body, system).toLowerCase();

/** A stop's surface position, when it has one. */
export function stopPosition(s: Stop): Position | null {
  const p = s.position;
  return p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? p : null;
}

/**
 * What to call a new bookmark, unique in the plan: the biology still to sample on the body (with
 * "(2)" and so on when that label is taken), else the next free "Bookmark N". `bio` says whether
 * it is for biology, from the data rather than the wording.
 */
export function bookmarkLabel(
  bio: ExobiologyBody | null,
  taken: string[],
  knownCount?: number | null,
): { label: string; bio: boolean } {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const left = bio ? bioLeft(bio, knownCount) : [];
  if (left.length) {
    const base = `Bio: ${left.join(", ")}`;
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base} (${n})`;
    return { label, bio: true };
  }
  const numbers = taken
    .map((t) => /^Bookmark (\d+)$/i.exec(t)?.[1])
    .filter(Boolean)
    .map(Number);
  return { label: `Bookmark ${Math.max(0, ...numbers) + 1}`, bio: false };
}

/**
 * The biology still to sample on a body: the species started but not analysed, the genera not
 * started, and signals with no genus known yet ("2 signals", before a surface scan).
 */
export function bioLeft(bio: ExobiologyBody, knownCount?: number | null): string[] {
  // Abandoned species are left out: their genus is back among those not started.
  const left = [
    ...bio.species.filter((s) => !s.analysed && !s.abandoned).map((s) => s.species),
    ...bio.not_started,
  ];
  // Spansh's count stands in when the journal has none (null, or 0 from a later scan).
  const unknown = Math.max(0, (bio.bio_signals || knownCount || 0) - bio.genera.length);
  return unknown ? [...left, `${unknown} signal${unknown === 1 ? "" : "s"}`] : left;
}

/**
 * The note on a bio bookmark the key made: while its label still starts "Bio: ", the panel
 * redraws it. A label the player or Claude wrote, even one starting "Bio: ", has no such note,
 * and a renamed one no longer starts so; both are kept.
 */
export const BIO_NOTE = "ED Chat keeps this label up to date from the journal.";

/**
 * What a bookmark's row says. A bio bookmark that the key made shows what is still to sample on
 * its body now, not when it was made, so finished species drop off. "All sampled" waits for the
 * journal's own signal count, as auto-done does (finishedBioBookmarks).
 */
function bookmarkText(
  s: Stop,
  bio: ExobiologyBody[] | null,
  known: KnownBody[] | null,
  system: string,
): string {
  const label = s.label ?? s.purpose;
  // The key's own label, not renamed since: it has the note and still starts "Bio: ".
  const own = s.notes === BIO_NOTE && label.startsWith("Bio: ");
  if (s.kind !== "exobiology" || !own || !bio || !s.body) return label;
  const key = bodyKey(s.body, system);
  const body = bio.find((b) => bodyKey(b.body, system) === key);
  if (!body) return label;
  const count = knownSignals(known, body.body_id);
  const left = bioLeft(body, count);
  // The " (2)" that kept the label unique stays, so two bookmarks on a body still differ.
  const n = / \(\d+\)$/.exec(label)?.[0] ?? "";
  // "All sampled" only when the journal says the body is done; with no count it may hold more.
  const what = left.length
    ? `Bio: ${left.join(", ")}`
    : bioProgress(body).done
      ? "Bio: all sampled"
      : "Bio: all found sampled, more may be here";
  return `${what}${n}`;
}

/** A bookmark as a plan stop. */
export function newBookmark(input: {
  system: string;
  body: string;
  here: Position;
  label: string;
  bio: boolean;
}): Stop & { position: Position } {
  return {
    system: input.system,
    body: input.body,
    purpose: input.label,
    label: input.label,
    kind: input.bio ? "exobiology" : "other",
    status: "todo",
    position: { ...input.here },
    ...(input.bio ? { notes: BIO_NOTE } : {}),
  };
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The initial great-circle bearing from one surface point to another, 0–359°. */
export function bearing(from: Position, to: Position): number {
  const φ1 = rad(from.latitude);
  const φ2 = rad(to.latitude);
  const Δλ = rad(to.longitude - from.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.round(deg(Math.atan2(y, x))) + 360) % 360;
}

/** "turn left 35°", "turn right 120°", or "ahead" within 10°. */
export function turn(heading: number, to: number): string {
  const d = ((to - heading + 540) % 360) - 180;
  if (Math.abs(d) < 10) return "ahead";
  return `turn ${d < 0 ? "left" : "right"} ${Math.abs(Math.round(d))}°`;
}

const distance = (m: number) => (m < 999.5 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/** Within this distance a bookmark shows as reached. */
const HERE_M = 100;

/** Bookmarks shown on the body, nearest first; the rest are counted. */
const MAX_ROWS = 5;

/**
 * The bookmarks to do in this system: on the body the ship or commander is at, one row each with
 * the distance, the bearing and the turn (when Status.json gives the planet's radius), nearest
 * first and at most five; on other bodies, one dim line per body with how many.
 */
export function bookmarkRows(input: {
  plan: Plan | null;
  system: string | null;
  status: ShipStatus | null;
  /** The system's exobiology from the journal, for what bio bookmarks still have to sample. */
  bio?: ExobiologyBody[] | null;
  /** Spansh's bodies in the system, for signal counts the journal lacks. */
  known?: KnownBody[] | null;
}): HudRow[] {
  const { plan, system, status } = input;
  if (!plan || !system) return [];
  const here = plan.stops.filter((s) => s.status === "todo" && s.body && same(s.system, system));
  if (!here.length) return [];
  const onBody = status?.body ? bodyKey(status.body, system) : null;
  const at =
    status && status.latitude !== null && status.longitude !== null
      ? { latitude: status.latitude, longitude: status.longitude }
      : null;
  const radius = status?.radius ?? null;
  const heading = status?.heading ?? null;
  const near: (HudRow & { d: number })[] = [];
  const elsewhere = new Map<string, { name: string; n: number }>();
  for (const s of here) {
    if (bodyKey(s.body!, system) !== onBody) {
      // Counted ignoring case, as the body is matched; named as first written.
      const key = bodyKey(s.body!, system);
      const seen = elsewhere.get(key);
      elsewhere.set(key, { name: seen?.name ?? shortBody(s.body!, system), n: (seen?.n ?? 0) + 1 });
      continue;
    }
    const text = `📍 ${bookmarkText(s, input.bio ?? null, input.known ?? null, system)}`;
    const pos = stopPosition(s);
    if (!pos || !at || radius === null) {
      // On the body, but where it is or where we are is not known.
      near.push({ text, right: pos ? "on this body" : "no position", tone: "accent", d: Infinity });
      continue;
    }
    const d = surfaceDistance(at, pos, radius);
    const b = bearing(at, pos);
    near.push({
      text,
      // Within 100 m it says "here", but keeps the bearing to find the exact spot on foot.
      right: [
        distance(d),
        d < HERE_M ? "here" : null,
        `${b}°`,
        heading !== null ? turn(heading, b) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone: d < HERE_M ? "good" : "accent",
      d,
    });
  }
  near.sort((a, b) => a.d - b.d);
  const rows: HudRow[] = near.slice(0, MAX_ROWS).map(({ d: _d, ...r }) => r);
  if (near.length > MAX_ROWS) {
    rows.push({ text: `📍 +${near.length - MAX_ROWS} more here`, tone: "dim" });
  }
  for (const { name: body, n } of elsewhere.values()) {
    rows.push({
      text: `📍 ${n} bookmark${n === 1 ? "" : "s"} on ${body}`,
      tone: "dim",
    });
  }
  return rows;
}

/**
 * The bookmark for where the ship or commander is now, labelled with the biology still to sample
 * there; or why there is none.
 */
export function bookmarkHere(
  journal: (JournalState & { events: JournalEvent[] }) | null,
  status: ShipStatus | null,
  taken: string[],
  /** Spansh's bodies in the system, for signal counts the journal lacks. */
  known?: KnownBody[] | null,
): { stop: ReturnType<typeof newBookmark> } | { reason: string } {
  const system = journal?.location.system ?? null;
  if (
    !journal ||
    !system ||
    !status?.body ||
    status.latitude === null ||
    status.longitude === null
  ) {
    return { reason: "no position: be on or near a planet" };
  }
  const address = systemAddress(journal.events, system);
  const body = bodyKey(status.body, system);
  const bio =
    address !== null
      ? (exobiology(journal.events, address, { system }).bodies.find(
          (b) => bodyKey(b.body, system) === body,
        ) ?? null)
      : null;
  const { label, bio: isBio } = bookmarkLabel(
    bio,
    taken,
    bio ? knownSignals(known, bio.body_id) : null,
  );
  return {
    stop: newBookmark({
      system,
      body: status.body,
      here: { latitude: status.latitude, longitude: status.longitude },
      label,
      bio: isBio,
    }),
  };
}

/** The bookmarks still to do, with a body as the panel shows them: their indexes in the plan. */
export const todoBookmarks = (plan: Plan | null): number[] =>
  (plan?.stops ?? []).flatMap((s, i) => (s.status === "todo" && s.body ? [i] : []));

/**
 * The bookmarks that the clear key clears, as indexes in the plan. On a body, the nearest
 * bookmark on it (the first when where it is or where the player is is not known). Elsewhere in
 * the system, every bookmark in the system (whole: true: the tray asks first, the key refuses). Only
 * bookmarks with a body, as the panel shows. Empty when the system has none.
 */
export function bookmarksToClear(input: {
  plan: Plan | null;
  system: string | null;
  status: ShipStatus | null;
}): { stops: number[]; whole: boolean } {
  const { plan, system, status } = input;
  if (!plan || !system) return { stops: [], whole: false };
  const here = todoBookmarks(plan).filter((i) => same(plan.stops[i]!.system, system));
  const onBody = status?.body ? bodyKey(status.body, system) : null;
  const body = here.filter((i) => bodyKey(plan.stops[i]!.body!, system) === onBody);
  if (!body.length) return { stops: here, whole: here.length > 0 };
  const at =
    status && status.latitude !== null && status.longitude !== null && status.radius !== null
      ? { latitude: status.latitude, longitude: status.longitude, radius: status.radius }
      : null;
  const far = (i: number) => {
    const pos = stopPosition(plan.stops[i]!);
    return pos && at ? surfaceDistance(at, pos, at.radius) : Infinity;
  };
  // The first of the nearest: a stable sort keeps the plan's order among equals.
  return { stops: [[...body].sort((a, b) => far(a) - far(b))[0]!], whole: false };
}

/** Whether an ed-mcp plan store error says the plan does not exist. */
export const isPlanNotFound = (err: unknown) =>
  err instanceof Error && /^Plan ".*" not found$/.test(err.message);

/**
 * The bio bookmarks still to do whose body, in this system, has every species analysed: their
 * indexes in the plan, to mark done.
 */
export function finishedBioBookmarks(
  plan: Plan | null,
  journal: (JournalState & { events: JournalEvent[] }) | null,
): number[] {
  const system = journal?.location.system ?? null;
  if (!plan || !journal || !system) return [];
  const todo = plan.stops.flatMap((s, i) =>
    s.status === "todo" && s.kind === "exobiology" && s.body && same(s.system, system) ? [i] : [],
  );
  // Most polls have no bio bookmark here: the journal is not read for them.
  if (!todo.length) return [];
  const address = systemAddress(journal.events, system);
  if (address === null) return [];
  const done = new Set(
    exobiology(journal.events, address, { system })
      // The journal's signal count alone: a stale Spansh count could mark one done early.
      .bodies.filter((b) => bioProgress(b).done)
      .map((b) => bodyKey(b.body, system)),
  );
  return todo.filter((i) => done.has(bodyKey(plan.stops[i]!.body!, system)));
}

/** The same bookmark and label: not another one added since in the same place. */
export const sameStop = (a: Stop, b: Stop) => sameBookmark(a, b) && a.label === b.label;

/** The same bookmark: what it is, not where it sits in the plan, which changes with edits. */
export const sameBookmark = (a: Stop, b: Stop) =>
  a.system === b.system &&
  a.body === b.body &&
  a.purpose === b.purpose &&
  JSON.stringify(stopPosition(a)) === JSON.stringify(stopPosition(b));

/**
 * How to name a bookmark still to do in the plan as it is now, for updateStop: by its label when
 * no other stop has it (ignoring case, as ed-mcp matches labels), so an edit between the read and
 * the write cannot move another stop under an index; else by its index. Null when it is gone.
 */
export function bookmarkRef(plan: Plan, stop: Stop): { label: string } | { index: number } | null {
  const todo = (s: Stop) => s.status === "todo" && sameBookmark(s, stop);
  // Two bookmarks in one spot can differ only by label: the one with this label first.
  let index = plan.stops.findIndex((s) => todo(s) && s.label === stop.label);
  if (index < 0) index = plan.stops.findIndex(todo);
  if (index < 0) return null;
  const label = plan.stops[index]!.label;
  if (!label) return { index };
  const lc = label.toLowerCase();
  return plan.stops.filter((s) => s.label?.toLowerCase() === lc).length === 1
    ? { label }
    : { index };
}

/** The bookmarks plan a key press saved, and how many polls had started by then. */
export interface SavedBookmarks {
  plan: Plan;
  afterPoll: number;
}

/**
 * A poll's data with the bookmarks just saved, when the poll (number `poll`, counting from 1)
 * started before the save and so read the plan without them. A poll that started after the save
 * read it: the saved plan is dropped, so Claude's later edits show.
 */
export function keepSavedBookmarks<T extends { bookmarks?: Plan | null }>(
  data: T,
  saved: SavedBookmarks | null,
  poll: number,
): { data: T; saved: SavedBookmarks | null } {
  if (!saved || poll > saved.afterPoll) return { data, saved: null };
  return { data: { ...data, bookmarks: saved.plan }, saved };
}
