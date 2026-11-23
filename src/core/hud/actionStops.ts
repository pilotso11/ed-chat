import {
  visitOrder,
  type Activity,
  type ActivityStore,
  type JournalEvent,
  type JournalState,
  type Plan,
  type PlanStore,
} from "ed-mcp/journal";
import { chooseBuild } from "./build.js";
import { hasActions, isBuildPlan, judgeBuild, judged } from "./buildJudge.js";
import { same } from "./json.js";
import { currentStop } from "./panels.js";
import { isTradePlan } from "./trade.js";

// Marking stop actions and stops done as the journal shows them, for every plan with actions:
// builds, trade routes and mission runs. Main gives the plan store, the activity note, the
// clipboard and the notices; the deciding is in buildJudge.ts (and build.ts for the build shown).

export interface ActionStopDeps {
  /** The plan store, or null before the panel's stores are open. */
  plans: () => Pick<
    PlanStore,
    "get" | "updateAction" | "updateStop" | "setBuildShip" | "setGearId"
  > | null;
  /**
   * The newest journal event's time (JournalService.newestEventAt()), given to the store as the
   * next lap's start with a stop marked done when the lap claimed no event (else its newest claim
   * goes). Without it, the poll's newest event.
   */
  newestEventAt?: () => Promise<string | null>;
  /** The activity note's store, for pointing the note at the new ship's plan on a ship swap. */
  activity: () => Pick<ActivityStore, "get" | "set"> | null;
  /** Copies a system for the galaxy map, with a note for the chat strip. */
  copy: (system: string, note: string) => void;
  notice: (text: string) => void;
  warn: (message: string) => void;
}

type Journal = JournalState & { events: JournalEvent[] };

export interface FinishInput {
  /** The activity note's plan. */
  note: Plan | null;
  /** The open plans with stop actions: the build plans among them are finished too. */
  plans: Plan[];
  journal: Journal | null;
  activity: Activity | null;
  /** Whether a plan's panel is on; every plan when not given. */
  on?: (plan: Plan) => boolean;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A stop's name for the plan's stop list: its place, so a rewritten plan does not match it. */
const stopId = (plan: Plan, i: number) => {
  const s = plan.stops[i]!;
  return `${i}|${s.system}|${s.station ?? s.body ?? ""}`;
};

/**
 * The stops with an action still to do in the plan, of a kind the judge judges: an action it
 * cannot see done (accept_mission) does not hold its stop open; a stop of only such actions waits
 * for a route key or Claude.
 */
const openStops = (plan: Plan) =>
  new Set(
    plan.stops.flatMap((s, i) =>
      s.actions?.some((a) => a.status === "todo" && judged(a)) ? [stopId(plan, i)] : [],
    ),
  );

/**
 * The system to copy after a stop is done: the next open stop after it in visit order (wrapping
 * round to earlier open stops only when none come after), as the panel's next row shows it, when
 * it is in another system.
 */
export function nextSystem(plan: Plan, done: number, here: string | null): string | null {
  const order = visitOrder(plan);
  const at = order.indexOf(done);
  const open = (i: number) => plan.stops[i]!.status === "todo";
  const next = order.slice(at + 1).find(open) ?? order.slice(0, at).find(open);
  const system = next === undefined ? null : plan.stops[next]!.system;
  return system && !same(system, here) ? system : null;
}

/** Action kinds of a mission run: a plan with any of them is the route's, whatever its stops. */
const MISSION_ACTIONS = new Set([
  "accept_mission",
  "complete_mission",
  "collect_cargo",
  "deliver_cargo",
]);

/**
 * The panel whose setting decides whether the finisher writes a plan: "build" for a plan with a
 * build (a suit loadout's too, which the finisher leaves alone anyway), "trade" for a trade plan,
 * else null (a mission run is the route's, even with trade stops: always on).
 */
export function finisherPanel(plan: Plan): "build" | "trade" | null {
  // Read before isBuildPlan(), whose type guard leaves nothing to read after it.
  const mission = plan.stops.some((s) => s.actions?.some((a) => MISSION_ACTIONS.has(a.kind)));
  if (plan.build || isBuildPlan(plan)) return "build";
  return !mission && isTradePlan(plan) ? "trade" : null;
}

export class ActionFinisher {
  /** Writes made or being made, by key ("Writing once" in the spec). */
  private readonly done = new Set<string>();
  /** For each plan, the stops with open actions after the last poll: a stop is marked on the change. */
  private readonly open = new Map<string, Set<string>>();
  /** The ship flown at the last poll, for the ship-swap note rule. */
  private ship: number | null | undefined = undefined;
  private lastError: string | null = null;
  /** The finish() running now: polls come each second, and a write can take longer. */
  private running: Promise<void> | null = null;

  constructor(private readonly deps: ActionStopDeps) {}

  /**
   * After a poll: marks the actions the journal shows done (each judged again on the plan as it is
   * now), marks a stop done when its last open action becomes done, writes a found ShipID, and on
   * a ship swap points the note at the new ship's build plan. A call while one is running does
   * nothing: the next poll judges again, so no action is written twice and no copy repeats.
   *
   * The plans finished are the open build plans and the note's plan (a trade route, a mission
   * run): an old trade plan left open is not the run being flown, and its actions would take this
   * run's trades. `on` leaves out a plan whose panel is turned off.
   */
  finish(input: FinishInput): Promise<void> {
    if (this.running) return Promise.resolve();
    const run = this.run(input).finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(input: FinishInput): Promise<void> {
    const plans = this.deps.plans();
    const journal = input.journal;
    if (!plans || !journal) return;
    const on = input.on ?? (() => true);
    const all = new Map<string, Plan>();
    if (hasActions(input.note) && on(input.note)) all.set(input.note.id, input.note);
    for (const p of input.plans) if (isBuildPlan(p) && on(p) && !all.has(p.id)) all.set(p.id, p);
    // The stop shown as current, before this poll's writes: finishing it copies the next one.
    const shown = chooseBuild({ note: input.note, plans: input.plans, journal });
    // Each plan on its own: one that fails is tried again on the next poll, the others go on.
    let failed: string | null = null;
    const attempt = async (what: () => Promise<void>) => {
      try {
        await what();
      } catch (err) {
        failed ??= message(err);
      }
    };
    // The newest event's time, read once a poll and only when a stop with no claim is marked.
    let lap: Promise<string | null> | null = null;
    const lapStart = () => (lap ??= this.lapStart(journal));
    for (const plan of all.values()) {
      // The stop shown as current: the build panel's for the build it shows, else the plan's own
      // for the note's plan (the trade panel and the route rows show that one).
      const current =
        shown?.plan.id === plan.id
          ? shown.current
          : plan.id === input.note?.id && !isBuildPlan(plan)
            ? currentStop(plan)
            : null;
      await attempt(() => this.finishPlan(plans, plan, journal, current, lapStart));
    }
    await attempt(() => this.swapNote(input, journal));
    if (failed !== null && failed !== this.lastError) this.deps.warn(failed);
    this.lastError = failed;
  }

  private async finishPlan(
    plans: NonNullable<ReturnType<ActionStopDeps["plans"]>>,
    plan: Plan,
    journal: Journal,
    current: number | null,
    lapStart: () => Promise<string | null>,
  ): Promise<void> {
    let now = plan;
    const writes = judgeBuild(plan, journal).actions.filter(
      (x) => x.write && !this.done.has(x.write.key),
    );
    // The stops open before this poll's writes, and the stops this poll wrote an action of.
    let openBefore = openStops(plan);
    const wrote = new Set<string>();
    if (writes.length) {
      // Judged again on the plan as it is now: Claude or a route key can change it after the poll.
      now = await plans.get(plan.id);
      openBefore = openStops(now);
      const fresh = judgeBuild(now, journal);
      for (const w of writes) {
        const key = w.write!.key;
        const again = fresh.actions.find((x) => x.write?.key === key);
        if (!again) continue;
        this.done.add(key);
        try {
          const { key: _key, ...patch } = again.write!;
          now = await plans.updateAction(
            now.id,
            { stop: { index: again.stop }, action: again.action.id },
            patch,
          );
          wrote.add(stopId(now, again.stop));
        } catch (err) {
          this.done.delete(key);
          throw err;
        }
      }
    }
    // A ShipID found from the journal, written once.
    const bound = judgeBuild(now, journal).boundId;
    // Only a ship build has a ship to write.
    if (bound !== null && now.build?.target === "ship" && now.build.ship_id === undefined) {
      const key = `${now.id}|ship|${bound}`;
      if (!this.done.has(key)) {
        this.done.add(key);
        try {
          now = await plans.setBuildShip(now.id, bound);
        } catch (err) {
          this.done.delete(key);
          throw err;
        }
      }
    }
    // On foot: a bought suit's or weapon's ID, into the actions with its gear key, once each.
    for (const g of judgeBuild(now, journal).gearIds) {
      const key = `${now.id}|gear|${g.gear}|${g.suit_id ?? g.weapon_id}`;
      if (this.done.has(key)) continue;
      this.done.add(key);
      try {
        const { gear, ...ids } = g;
        now = await plans.setGearId(now.id, gear, ids);
      } catch (err) {
        this.done.delete(key);
        throw err;
      }
    }
    // A stop is marked done only on the change: its last open action became done since the last
    // poll, or by this poll's own writes. Otherwise the first poll only notes which stops are open,
    // so a stop done while ED Chat was off waits for a route key.
    const open = openStops(now);
    const before = this.open.get(now.id);
    const toMark = visitOrder(now).filter((i) => {
      const s = now.stops[i]!;
      const id = stopId(now, i);
      const changed = before?.has(id) || (wrote.has(id) && openBefore.has(id));
      return changed && !open.has(id) && s.status === "todo" && !!s.actions?.length;
    });
    // The record is updated only once the stops are marked: a stop whose write fails stays in it
    // as open, so the next poll sees the change again and tries once more.
    const marked = new Set<number>();
    try {
      await this.markStops(plans, now, toMark, marked, journal, current, lapStart);
    } catch (err) {
      const left = toMark.filter((i) => !marked.has(i)).map((i) => stopId(now, i));
      this.open.set(now.id, new Set([...open, ...left]));
      throw err;
    }
    this.open.set(now.id, open);
  }

  private async markStops(
    plans: NonNullable<ReturnType<ActionStopDeps["plans"]>>,
    plan: Plan,
    stops: number[],
    marked: Set<number>,
    journal: Journal,
    current: number | null,
    lapStart: () => Promise<string | null>,
  ): Promise<void> {
    let now = plan;
    // The lap's newest claim, judged before any write resets the lap: the next lap starts at it,
    // so what was done after it (before this write) counts for the next lap, and nothing this lap
    // claimed, at any of its stops, counts again. With no claim, the newest event.
    const last = Math.max(-1, ...judgeBuild(plan, journal).actions.map((x) => x.lastClaim));
    for (const i of stops) {
      const s = now.stops[i]!;
      // Given with every stop: the store uses it only when the stop ends a loop's lap.
      const start = journal.events[last]?.timestamp ?? (await lapStart());
      const updated = await plans.updateStop(
        now.id,
        { index: i },
        { status: "done" },
        start ? { lapStart: start } : undefined,
      );
      marked.add(i);
      const name =
        s.label ??
        (s.kind === "trade" ? s.purpose : s.station ? `${s.system} · ${s.station}` : s.system);
      if (i === current) {
        const next = nextSystem(updated, i, journal.location.system);
        if (next) this.deps.copy(next, `${name}: done. Next stop copied: ${next}`);
        else this.deps.notice(`✓ ${name}: done`);
      }
      now = updated;
    }
  }

  /** The newest journal event's time: the store's, else the poll's newest event. */
  private async lapStart(journal: Journal): Promise<string | null> {
    const newest = await this.deps.newestEventAt?.().catch(() => null);
    return newest ?? journal.events.at(-1)?.timestamp ?? null;
  }

  /**
   * On a ship swap to a ship with a build plan, while the note names another ship's build plan,
   * the note is pointed at the new ship's plan: the only time the panel changes the note.
   */
  private async swapNote(input: FinishInput, journal: Journal): Promise<void> {
    const ship = journal.ship.id;
    const was = this.ship;
    if (ship === null || ship === was) return;
    // The ship is noted as seen only once the note is written, or there is nothing to write: a
    // swap whose note could not be written yet is tried again on the next poll.
    const seen = () => {
      this.ship = ship;
    };
    if (was === undefined) return seen();
    const note = input.note;
    // A build plan whose panel is off is left alone, as when it is not one.
    if (!isBuildPlan(note) || !(input.on?.(note) ?? true)) return seen();
    const noteShip = judgeBuild(note, journal).shipId;
    if (noteShip === null || noteShip === ship) return seen();
    const mine = input.plans.find(
      (p) => p.id !== note.id && isBuildPlan(p) && judgeBuild(p, journal).shipId === ship,
    );
    if (!mine) return seen();
    const store = this.deps.activity();
    if (!store || !input.activity) return;
    const activity = await store.get();
    if (!activity || activity.plan_id !== note.id) return seen();
    await store.set({
      kind: activity.kind,
      summary: (mine.build?.summary ?? mine.name).slice(0, 500),
      plan_id: mine.id,
    });
    seen();
    this.deps.notice(`📋 ${mine.name}: now the activity note's plan`);
  }
}
