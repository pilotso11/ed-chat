import type { JournalEvent } from "ed-mcp/journal";

// Credits an hour, for the exploration and trade panels: time spent at something, with time away
// left out, and the session's and the last half hour's rates.

/** A rate needs this long, so the first scan or sale does not read as a huge hourly rate. */
export const RATE_MIN_MS = 5 * 60_000;
/** The recent rate: the last half hour. */
export const RECENT_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;
/** A gap between events longer than this is time away: only this much of it counts. */
export const IDLE_MS = 10 * 60_000;

/**
 * Time spent at something: from start() to stop(), from event to event, where a gap counts up to
 * IDLE_MS, so time docked or away does not lower a rate.
 */
export class ActiveClock {
  private last: number | null = null;
  /**
   * Each counted stretch, from its start: a gap counts as its first IDLE_MS, so the time away
   * after it falls outside any window that starts later.
   */
  private readonly spans: { from: number; ms: number }[] = [];

  start(at: number): void {
    if (this.last === null) this.last = at;
  }

  tick(at: number): void {
    if (this.last === null) return;
    const ms = Math.min(Math.max(0, at - this.last), IDLE_MS);
    if (ms) this.spans.push({ from: this.last, ms });
    this.last = at;
  }

  stop(at: number): void {
    this.tick(at);
    this.halt();
  }

  /** Stops without counting the time since the last event: it was spent away. */
  halt(): void {
    this.last = null;
  }

  /**
   * The time counted until now, with the time since the last event as one more stretch; with
   * `since`, only the part of each stretch after it.
   */
  total(now: number, since = -Infinity): number {
    const after = (from: number, ms: number) => Math.max(0, from + ms - Math.max(from, since));
    const tail =
      this.last !== null ? after(this.last, Math.min(Math.max(0, now - this.last), IDLE_MS)) : 0;
    return this.spans.reduce((n, s) => n + after(s.from, s.ms), tail);
  }
}

/** Credits an hour over ms of counted time; null while that is under RATE_MIN_MS. */
export const perHour = (credits: number, ms: number) =>
  ms >= RATE_MIN_MS ? (credits * HOUR_MS) / ms : null;

/** Credits an hour for the session and the last half hour; null while too new. */
export interface Rates {
  session: number | null;
  recent: number | null;
}

/** The session's rate, and the last half hour's, from what was earned and when. */
export function rates(
  clock: ActiveClock,
  earned: { at: number; credits: number }[],
  now: number,
): Rates {
  const sum = (list: { credits: number }[]) => list.reduce((n, x) => n + x.credits, 0);
  const elapsed = clock.total(now);
  return {
    session: perHour(sum(earned), elapsed),
    // Only once the session is longer than the window, else it repeats the session rate. Over
    // the time spent in the window, so time away does not lower it either.
    recent:
      elapsed > RECENT_MS
        ? perHour(
            sum(earned.filter((x) => x.at > now - RECENT_MS)),
            clock.total(now, now - RECENT_MS),
          )
        : null,
  };
}

/**
 * The events a new game's journal starts with, before LoadGame. A full journal rolls over to a
 * new part mid-game with a Fileheader too, but its part is 2 or more.
 */
export const newGame = (e: JournalEvent) =>
  e.event === "Commander" ||
  e.event === "LoadGame" ||
  (e.event === "Fileheader" && !(Number(e.part) > 1));
