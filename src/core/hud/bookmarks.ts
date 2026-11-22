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
import { shortBody, type HudRow } from "./panels.js";

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
): { label: string; bio: boolean } {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  // Abandoned species are left out: their genus is back among those not started.
  const left = bio
    ? [
        ...bio.species.filter((s) => !s.analysed && !s.abandoned).map((s) => s.species),
        ...bio.not_started,
      ]
    : [];
  // Signals with no genus known yet (no surface scan) are biology too.
  const unknown = bio ? Math.max(0, (bio.bio_signals ?? 0) - bio.genera.length) : 0;
  if (left.length || unknown) {
    const base = `Bio: ${[...left, ...(unknown ? [`${unknown} signal${unknown === 1 ? "" : "s"}`] : [])].join(", ")}`;
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
  status: (ShipStatus & { heading?: number | null }) | null;
}): HudRow[] {
  const { plan, system, status } = input;
  if (!plan || !system) return [];
  const here = plan.stops.filter(
    (s) => s.status === "todo" && s.body && s.system.toLowerCase() === system.toLowerCase(),
  );
  if (!here.length) return [];
  const onBody = status?.body ? bodyKey(status.body, system) : null;
  const at =
    status && status.latitude !== null && status.longitude !== null
      ? { latitude: status.latitude, longitude: status.longitude }
      : null;
  const radius = status?.radius ?? null;
  const heading = status?.heading ?? null;
  const near: (HudRow & { d: number })[] = [];
  const elsewhere = new Map<string, number>();
  for (const s of here) {
    if (bodyKey(s.body!, system) !== onBody) {
      const name = shortBody(s.body!, system);
      elsewhere.set(name, (elsewhere.get(name) ?? 0) + 1);
      continue;
    }
    const text = `📍 ${s.label ?? s.purpose}`;
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
  for (const [body, n] of elsewhere) {
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
  const { label, bio: isBio } = bookmarkLabel(bio, taken);
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
    s.status === "todo" &&
    s.kind === "exobiology" &&
    s.body &&
    s.system.toLowerCase() === system.toLowerCase()
      ? [i]
      : [],
  );
  // Most polls have no bio bookmark here: the journal is not read for them.
  if (!todo.length) return [];
  const address = systemAddress(journal.events, system);
  if (address === null) return [];
  const done = new Set(
    exobiology(journal.events, address, { system })
      .bodies.filter(
        (b) =>
          b.species.length > 0 &&
          b.species.every((s) => s.analysed) &&
          !b.not_started.length &&
          // Every signal sampled, not just every genus seen so far.
          b.species.length >= (b.bio_signals ?? 0),
      )
      .map((b) => bodyKey(b.body, system)),
  );
  return todo.filter((i) => done.has(bodyKey(plan.stops[i]!.body!, system)));
}

/** The same bookmark: what it is, not where it sits in the plan, which changes with edits. */
export const sameBookmark = (a: Stop, b: Stop) =>
  a.system === b.system &&
  a.body === b.body &&
  a.purpose === b.purpose &&
  JSON.stringify(stopPosition(a)) === JSON.stringify(stopPosition(b));
