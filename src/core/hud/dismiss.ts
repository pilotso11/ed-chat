import type { ActivityStore, PlanStore } from "ed-mcp/journal";

// /dismiss-plan: takes plans off the panel without asking the assistant.

export interface DismissDeps {
  activity: Pick<ActivityStore, "clear">;
  plans: Pick<PlanStore, "list" | "get" | "updateAction">;
}

export interface Dismissed {
  /** Whether there was an activity note to clear. */
  cleared: boolean;
  /** The names of the plans with stop actions still to do (after all, those left open). */
  open: string[];
  /** The names of the plans whose open actions were marked skipped (all only). */
  skipped: string[];
  /** The plans a write failed for, with the error (all only). */
  failed: { name: string; error: string }[];
  /** Every plan with stop actions, open or not: the panel forgets the ones it keeps (all only). */
  forget: string[];
}

/** Whether an action is still to do: not done and not skipped. */
const isOpen = (status: string | undefined) => status !== "done" && status !== "skipped";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Clears the activity note, so the panel shows no plan for it. With all, also marks skipped every
 * open stop action of every plan that has some (builds, trade runs, mission plans, wherever their
 * stops are), so docking at one of their stops does not bring them back. Skipped, not deleted:
 * the plans stay, and the assistant can reopen them. The plans are read from the store, not the
 * panel's last poll, so an action finished meanwhile is not marked skipped. A plan whose write
 * fails is reported, and the others go on.
 */
export async function dismissPlan(deps: DismissDeps, all: boolean): Promise<Dismissed> {
  const cleared = await deps.activity.clear();
  const list = (await deps.plans.list()).filter((p) => (p.actions ?? 0) > 0);
  const openList = list.filter((p) => p.actions! > (p.actions_done ?? 0));
  const result: Dismissed = { cleared, open: [], skipped: [], failed: [], forget: [] };
  if (!all) {
    result.open = openList.map((p) => p.name);
    return result;
  }
  result.forget = list.map((p) => p.id);
  for (const summary of openList) {
    try {
      const plan = await deps.plans.get(summary.id);
      let wrote = false;
      for (const [index, stop] of plan.stops.entries())
        for (const a of stop.actions ?? []) {
          if (!isOpen(a.status)) continue;
          await deps.plans.updateAction(
            plan.id,
            { stop: { index }, action: a.id },
            { status: "skipped" },
          );
          wrote = true;
        }
      if (wrote) result.skipped.push(plan.name);
    } catch (err) {
      result.failed.push({ name: summary.name, error: message(err) });
    }
  }
  result.open = result.failed.map((f) => f.name);
  return result;
}

/** The confirmation line for a dismissal. */
export function dismissText(d: Dismissed, all: boolean): string {
  const note = d.cleared ? "plan dismissed" : null;
  if (d.failed.length > 0) {
    const done = d.skipped.length > 0 ? `; skipped what was left of ${d.skipped.join(", ")}` : "";
    const failed = d.failed.map((f) => `${f.name} (${f.error})`).join(", ");
    return `⚠ ${note ?? "no activity plan"}${done}; could not skip ${failed}`;
  }
  if (all && d.skipped.length > 0)
    return `✓ ${note ?? "no activity plan"}; skipped what was left of ${d.skipped.join(", ")}`;
  if (!all && d.open.length > 0) {
    const still = `${d.open.join(", ")} still ${d.open.length === 1 ? "shows" : "show"} at ${d.open.length === 1 ? "its" : "their"} stops: /dismiss-plan all`;
    return note ? `✓ ${note}; ${still}` : `ⓘ no activity plan; ${still}`;
  }
  return note ? `✓ ${note}` : "ⓘ no plan to dismiss";
}
