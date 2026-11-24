import type { ActivityStore, Plan, PlanStore } from "ed-mcp/journal";
import { currentStop } from "./panels.js";

// /dismiss-plan and /dismiss-step: put away the plan on the panel, or its current stop, without
// asking the assistant. Only that plan is changed. Actions are skipped, not deleted: the plan
// stays, and the assistant can reopen it.

export interface DismissDeps {
  activity: Pick<ActivityStore, "get" | "clear">;
  plans: Pick<PlanStore, "get" | "updateAction" | "updateStop">;
}

/** Whether an action is still to do: not done and not skipped. */
const isOpen = (status: string | undefined) => status !== "done" && status !== "skipped";

/** Marks skipped the open actions of the given stops of a plan, as the store has it now. */
async function skipActions(deps: DismissDeps, plan: Plan, stops: number[]): Promise<number> {
  let n = 0;
  for (const index of stops)
    for (const a of plan.stops[index]?.actions ?? []) {
      if (!isOpen(a.status)) continue;
      await deps.plans.updateAction(
        plan.id,
        { stop: { index }, action: a.id },
        { status: "skipped" },
      );
      n++;
    }
  return n;
}

export interface PlanDismissed {
  name: string;
  /** Open actions marked skipped. */
  skipped: number;
  /** Whether the activity note named this plan, and was cleared. */
  cleared: boolean;
}

/**
 * /dismiss-plan: marks skipped every open action of the plan on the panel, read fresh from the
 * store, and clears the activity note when it names that plan. Other plans are left alone.
 */
export async function dismissPlan(deps: DismissDeps, planId: string): Promise<PlanDismissed> {
  const plan = await deps.plans.get(planId);
  const skipped = await skipActions(
    deps,
    plan,
    plan.stops.map((_, i) => i),
  );
  const note = await deps.activity.get();
  const cleared = note?.plan_id === planId ? await deps.activity.clear() : false;
  return { name: plan.name, skipped, cleared };
}

export function planDismissedText(d: PlanDismissed): string {
  if (d.skipped === 0 && !d.cleared) return `ⓘ ${d.name}: nothing left to dismiss`;
  return `✓ ${d.name} dismissed`;
}

export interface StepDismissed {
  name: string;
  /** The stop skipped, as the panel names it; null when there was none to do. */
  stop: string | null;
  /** The plan after the write. */
  plan: Plan;
}

/**
 * /dismiss-step: marks the plan's current stop skipped, with its open actions, so the plan moves
 * on to its next stop. current is the stop the panel shows as current, when it gives one.
 */
export async function dismissStep(
  deps: DismissDeps,
  planId: string,
  current: number | null | undefined,
  lapStart: string | null,
): Promise<StepDismissed> {
  const plan = await deps.plans.get(planId);
  // The panel's stop, if still to do in the plan as it is now; else the plan's own current one.
  const shown = current ?? null;
  const index = shown !== null && plan.stops[shown]?.status === "todo" ? shown : currentStop(plan);
  if (index === null) return { name: plan.name, stop: null, plan };
  const stop = plan.stops[index]!;
  await skipActions(deps, plan, [index]);
  const now = await deps.plans.updateStop(
    plan.id,
    { index },
    { status: "skipped" },
    lapStart ? { lapStart } : undefined,
  );
  return { name: plan.name, stop: stop.station ?? stop.body ?? stop.system, plan: now };
}

export function stepDismissedText(d: StepDismissed): string {
  return d.stop === null ? `ⓘ ${d.name}: no stop left to do` : `✓ skipped ${d.stop}`;
}
