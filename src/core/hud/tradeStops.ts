import type { JournalEvent, JournalState, Plan, PlanStore } from "ed-mcp/journal";
import { tradeAdvance, tradeNextCopy } from "./trade.js";

// Marking a trade stop with no stop actions done once its cargo rows' buys and sales are: the
// fallback for a plan saved before ed-mcp wrote actions, a stop that only passes through, and a
// loop's first stop on its first lap. A stop with actions is ActionFinisher's (actionStops.ts).
// Main gives the plan store, the clipboard and the notices; the deciding is in tradeAdvance().

export interface TradeStopDeps {
  /** The plan store, or null before the panel's stores are open. */
  plans: () => Pick<PlanStore, "get" | "updateStop"> | null;
  /** Copies a system for the galaxy map, with a note for the chat strip. */
  copy: (system: string, note: string) => void;
  notice: (text: string) => void;
  warn: (message: string) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class TradeStopFinisher {
  /** Stops marked or being marked, by tradeAdvance()'s key: each once per docking and lap. */
  private readonly done = new Set<string>();
  /** The last failure, logged once: a plan that cannot be judged fails on every poll. */
  private lastError: string | null = null;

  constructor(private readonly deps: TradeStopDeps) {}

  /**
   * After a poll: marks the current trade stop done when the journal shows its action done, and
   * copies the next stop's system. The stop is judged again on the plan as it is now, since
   * Claude or a route key can change it after the poll. A changed plan or a failed write leaves
   * the stop to be judged again on the next poll.
   */
  async finish(
    plan: Plan | null,
    journal: (JournalState & { events: JournalEvent[] }) | null,
  ): Promise<void> {
    const plans = this.deps.plans();
    if (!plans || !plan || !journal) return;
    const judge = (p: Plan | null) =>
      tradeAdvance({
        plan: p,
        events: journal.events,
        cargo: journal.cargo,
        capacity: journal.ship.cargo_capacity,
        location: journal.location,
      });
    let key: string | null = null;
    try {
      const step = judge(plan);
      if (!step || this.done.has(step.key)) return;
      key = step.key;
      this.done.add(key);
      const now = await plans.get(plan.id);
      if (judge(now)?.key !== key) {
        this.done.delete(key);
        return;
      }
      const stop = now.stops[step.index]!;
      const updated = await plans.updateStop(now.id, { index: step.index }, { status: "done" });
      const next = tradeNextCopy(updated, journal.location.system);
      const done = stop.label ?? stop.purpose;
      if (next) this.deps.copy(next, `${done}: done. Next stop copied: ${next}`);
      else this.deps.notice(`✓ ${done}: done`);
      this.lastError = null;
    } catch (err) {
      if (key) this.done.delete(key);
      if (message(err) !== this.lastError) this.deps.warn(message(err));
      this.lastError = message(err);
    }
  }
}
