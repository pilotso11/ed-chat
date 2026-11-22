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
import { isBuildPlan, judgeBuild } from "./buildJudge.js";
import { tradeNextCopy } from "./trade.js";

// Marking build actions and stops done as the journal shows them: main gives the plan store, the
// activity note, the clipboard and the notices; the deciding is in build.ts and buildJudge.ts.

export interface BuildStopDeps {
  /** The plan store, or null before the panel's stores are open. */
  plans: () => Pick<PlanStore, "get" | "updateAction" | "updateStop" | "setBuildShip"> | null;
  /** The activity note's store, for pointing the note at the new ship's plan on a ship swap. */
  activity: () => Pick<ActivityStore, "get" | "set"> | null;
  /** Copies a system for the galaxy map, with a note for the chat strip. */
  copy: (system: string, note: string) => void;
  notice: (text: string) => void;
  warn: (message: string) => void;
}

type Journal = JournalState & { events: JournalEvent[] };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A stop's name for the plan's stop list: its place, so a rewritten plan does not match it. */
const stopId = (plan: Plan, i: number) => {
  const s = plan.stops[i]!;
  return `${i}|${s.system}|${s.station ?? s.body ?? ""}`;
};

/** The stops with an action still to do in the plan. */
const openStops = (plan: Plan) =>
  new Set(
    plan.stops.flatMap((s, i) =>
      s.actions?.some((a) => a.status === "todo") ? [stopId(plan, i)] : [],
    ),
  );

export class BuildFinisher {
  /** Writes made or being made, by key ("Writing once" in the spec). */
  private readonly done = new Set<string>();
  /** For each plan, the stops with open actions after the last poll: a stop is marked on the change. */
  private readonly open = new Map<string, Set<string>>();
  /** The ship flown at the last poll, for the ship-swap note rule. */
  private ship: number | null | undefined = undefined;
  private lastError: string | null = null;

  constructor(private readonly deps: BuildStopDeps) {}

  /**
   * After a poll: marks the actions the journal shows done (each judged again on the plan as it is
   * now), marks a stop done when its last open action becomes done, writes a found ShipID, and on
   * a ship swap points the note at the new ship's build plan.
   */
  async finish(input: {
    note: Plan | null;
    plans: Plan[];
    journal: Journal | null;
    activity: Activity | null;
  }): Promise<void> {
    const plans = this.deps.plans();
    const journal = input.journal;
    if (!plans || !journal) return;
    const all = new Map<string, Plan>();
    for (const p of [input.note, ...input.plans]) if (isBuildPlan(p)) all.set(p.id, p);
    // The stop shown as current, before this poll's writes: finishing it copies the next one.
    const shown = chooseBuild({ note: input.note, plans: input.plans, journal });
    try {
      for (const plan of all.values()) {
        const current = shown?.plan.id === plan.id && shown.current !== null ? shown.current : null;
        await this.finishPlan(plans, plan, journal, current);
      }
      await this.swapNote(input, journal);
      this.lastError = null;
    } catch (err) {
      if (message(err) !== this.lastError) this.deps.warn(message(err));
      this.lastError = message(err);
    }
  }

  private async finishPlan(
    plans: NonNullable<ReturnType<BuildStopDeps["plans"]>>,
    plan: Plan,
    journal: Journal,
    current: number | null,
  ): Promise<void> {
    let now = plan;
    const writes = judgeBuild(plan, journal).actions.filter(
      (x) => x.write && !this.done.has(x.write.key),
    );
    if (writes.length) {
      // Judged again on the plan as it is now: Claude or a route key can change it after the poll.
      now = await plans.get(plan.id);
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
        } catch (err) {
          this.done.delete(key);
          throw err;
        }
      }
    }
    // A ShipID found from the journal, written once.
    const bound = judgeBuild(now, journal).boundId;
    if (bound !== null && now.build && now.build.ship_id === undefined) {
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
    // A stop is marked done only on the change: its last open action became done since the last
    // poll. The first poll only notes which stops are open.
    const open = openStops(now);
    const before = this.open.get(now.id);
    this.open.set(now.id, open);
    if (!before) return;
    for (const i of visitOrder(now)) {
      const s = now.stops[i]!;
      if (!before.has(stopId(now, i)) || open.has(stopId(now, i))) continue;
      if (s.status !== "todo" || !s.actions?.length) continue;
      const updated = await plans.updateStop(now.id, { index: i }, { status: "done" });
      const name = s.label ?? (s.station ? `${s.system} · ${s.station}` : s.system);
      if (i === current) {
        const next = tradeNextCopy(updated, journal.location.system);
        if (next) this.deps.copy(next, `${name}: done. Next stop copied: ${next}`);
        else this.deps.notice(`✓ ${name}: done`);
      }
      now = updated;
    }
  }

  /**
   * On a ship swap to a ship with a build plan, while the note names another ship's build plan,
   * the note is pointed at the new ship's plan: the only time the panel changes the note.
   */
  private async swapNote(
    input: { note: Plan | null; plans: Plan[]; activity: Activity | null },
    journal: Journal,
  ): Promise<void> {
    const ship = journal.ship.id;
    const was = this.ship;
    this.ship = ship;
    if (was === undefined || ship === null || ship === was) return;
    const note = input.note;
    if (!isBuildPlan(note) || !input.activity) return;
    const noteShip = judgeBuild(note, journal).shipId;
    if (noteShip === null || noteShip === ship) return;
    const mine = input.plans.find(
      (p) => p.id !== note.id && isBuildPlan(p) && judgeBuild(p, journal).shipId === ship,
    );
    const store = this.deps.activity();
    if (!mine || !store) return;
    const activity = await store.get();
    if (!activity || activity.plan_id !== note.id) return;
    await store.set({ kind: activity.kind, summary: activity.summary, plan_id: mine.id });
    this.deps.notice(`📋 ${mine.name}: now the activity note's plan`);
  }
}
