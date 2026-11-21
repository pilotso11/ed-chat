import type { Plan } from "ed-mcp/journal";
import { currentStop, nextStopAfter, previousStop } from "./panels.js";

// The route keys and arriving at a stop: what changes in the plan, and what is copied.

/**
 * Arriving in the current stop's system: the next stop's system, in another system, for the
 * galaxy map. Null when there is nothing to copy.
 */
export function arrivalCopy(plan: Plan | null | undefined, system: string): string | null {
  if (!plan) return null;
  const i = currentStop(plan);
  if (i === null || plan.stops[i]!.system.toLowerCase() !== system.toLowerCase()) return null;
  const j = nextStopAfter(plan, i);
  return j === null ? null : plan.stops[j]!.system;
}

export type RouteStep = { update: { index: number; status: "done" | "todo" } } | { notice: string };

/**
 * A route key: forward marks the current stop done; back puts the stop done last, in visit
 * order, back to todo.
 */
export function routeStep(plan: Plan | null | undefined, dir: 1 | -1): RouteStep {
  if (!plan) return { notice: "ⓘ no active route plan" };
  if (dir === 1) {
    const i = currentStop(plan);
    return i === null ? { notice: "ⓘ route finished" } : { update: { index: i, status: "done" } };
  }
  const prev = previousStop(plan);
  return prev === null
    ? { notice: "ⓘ at the first stop" }
    : { update: { index: prev, status: "todo" } };
}

/** After a route key: the system of the stop to fly to now, to copy. */
export function currentSystem(plan: Plan | null): string | null {
  const cur = plan ? currentStop(plan) : null;
  return plan && cur !== null ? plan.stops[cur]!.system : null;
}
