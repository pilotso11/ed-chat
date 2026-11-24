import type { ActivityStore, Plan, PlanStore } from "ed-mcp/journal";

// /dismiss-plan: takes plans off the panel without asking the assistant.

export interface DismissDeps {
  activity: Pick<ActivityStore, "clear">;
  plans: Pick<PlanStore, "updateAction">;
}

export interface Dismissed {
  /** Whether there was an activity note to clear. */
  cleared: boolean;
  /** The plans whose open actions were marked skipped (all only). */
  skipped: Plan[];
}

/** Whether an action is still to do: not done and not skipped. */
const open = (status: string | undefined) => status !== "done" && status !== "skipped";

/**
 * Clears the activity note, so the panel shows no plan for it. With all, also marks every open
 * stop action skipped in the plans given (the plans with actions the panel can show), so docking
 * at one of their stops does not bring them back. Skipped, not deleted: the plans stay, and the
 * assistant can reopen them.
 */
export async function dismissPlan(
  deps: DismissDeps,
  actionPlans: readonly Plan[],
  all: boolean,
): Promise<Dismissed> {
  const cleared = await deps.activity.clear();
  const skipped: Plan[] = [];
  if (!all) return { cleared, skipped };
  for (const plan of actionPlans) {
    let wrote = false;
    for (const [index, stop] of plan.stops.entries())
      for (const a of stop.actions ?? []) {
        if (!open(a.status)) continue;
        await deps.plans.updateAction(
          plan.id,
          { stop: { index }, action: a.id },
          { status: "skipped" },
        );
        wrote = true;
      }
    if (wrote) skipped.push(plan);
  }
  return { cleared, skipped };
}

/** The confirmation line for a dismissal. */
export function dismissText(d: Dismissed, all: boolean): string {
  const names = d.skipped.map((p) => p.name);
  if (all && names.length > 0)
    return `✓ plan dismissed; skipped what was left of ${names.join(", ")}`;
  if (d.cleared)
    return all
      ? "✓ plan dismissed"
      : "✓ plan dismissed (a build or trade plan still shows at its stops: /dismiss-plan all)";
  return all ? "ⓘ no plan to dismiss" : "ⓘ no activity plan to dismiss";
}
