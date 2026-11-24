import type { Plan } from "ed-mcp/journal";
import { describe, expect, it, vi } from "vitest";
import {
  dismissPlan,
  dismissStep,
  planDismissedText,
  stepDismissedText,
} from "../src/core/hud/dismiss.js";

/** A plan with a stop per list of action statuses; a stop with none has no actions. */
const plan = (id: string, statuses: string[][], stopStatus: string[] = []): Plan =>
  ({
    id,
    name: `${id} plan`,
    items: [],
    stops: statuses.map((s, i) => ({
      system: `Sys${i}`,
      station: `P${i}`,
      kind: "shop",
      status: stopStatus[i] ?? "todo",
      ...(s.length > 0 && {
        actions: s.map((status, j) => ({
          id: `a${i}${j}`,
          kind: "buy_module",
          label: "x",
          status,
        })),
      }),
    })),
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
  }) as unknown as Plan;

const deps = (p: Plan, noteFor: string | null = p.id) => ({
  activity: {
    get: vi.fn(async () => (noteFor ? { kind: "trading", summary: "s", plan_id: noteFor } : null)),
    clear: vi.fn(async () => true),
  },
  plans: {
    get: vi.fn(async () => structuredClone(p)),
    updateAction: vi.fn(async () => p),
    updateStop: vi.fn(async (_id: string, ref: { index?: number }) => {
      const now = structuredClone(p);
      now.stops[ref.index!]!.status = "skipped";
      return now;
    }),
  },
});

describe("dismissPlan", () => {
  it("skips every open action of the plan and clears the note naming it", async () => {
    const p = plan("krait", [["done", "todo"], ["skipped"], ["in_progress"]]);
    const d = deps(p);
    expect(await dismissPlan(d as never, "krait")).toEqual({
      name: "krait plan",
      skipped: 2,
      cleared: true,
    });
    expect(d.plans.updateAction.mock.calls).toEqual([
      ["krait", { stop: { index: 0 }, action: "a01" }, { status: "skipped" }],
      ["krait", { stop: { index: 2 }, action: "a20" }, { status: "skipped" }],
    ]);
    expect(d.plans.updateStop).not.toHaveBeenCalled();
  });

  it("leaves a note that names another plan", async () => {
    const d = deps(plan("krait", [["todo"]]), "route");
    expect((await dismissPlan(d as never, "krait")).cleared).toBe(false);
    expect(d.activity.clear).not.toHaveBeenCalled();
  });

  it("clears the note of a route plan with no actions", async () => {
    const d = deps(plan("route", [[], []]));
    expect(await dismissPlan(d as never, "route")).toEqual({
      name: "route plan",
      skipped: 0,
      cleared: true,
    });
  });
});

describe("dismissStep", () => {
  it("skips the stop the panel shows, with its open actions", async () => {
    const p = plan("krait", [["todo"], ["done", "todo"], []]);
    const d = deps(p);
    const r = await dismissStep(d as never, "krait", 1, "2026-11-24T01:00:00Z");
    expect(r.stop).toBe("P1");
    expect(r.index).toBe(1);
    expect(d.plans.updateAction.mock.calls).toEqual([
      ["krait", { stop: { index: 1 }, action: "a11" }, { status: "skipped" }],
    ]);
    expect(d.plans.updateStop.mock.calls).toEqual([
      ["krait", { index: 1 }, { status: "skipped" }, { lapStart: "2026-11-24T01:00:00Z" }],
    ]);
    expect(r.plan.stops[1]!.status).toBe("skipped");
  });

  it("takes the plan's current stop when the panel gives none, or one no longer to do", async () => {
    const p = plan("route", [[], [], []], ["done"]);
    const d = deps(p);
    expect((await dismissStep(d as never, "route", undefined, null)).stop).toBe("P1");
    expect((await dismissStep(d as never, "route", 0, null)).stop).toBe("P1");
    expect(d.plans.updateStop.mock.calls[0]).toEqual([
      "route",
      { index: 1 },
      { status: "skipped" },
      undefined,
    ]);
  });

  it("says so when no stop is left", async () => {
    const d = deps(plan("route", [[]], ["done"]));
    const r = await dismissStep(d as never, "route", undefined, null);
    expect(r.stop).toBeNull();
    expect(d.plans.updateStop).not.toHaveBeenCalled();
  });
});

describe("the confirmations", () => {
  it("say what was dismissed", () => {
    expect(planDismissedText({ name: "Krait", skipped: 2, cleared: false })).toBe(
      "✓ Krait dismissed",
    );
    expect(planDismissedText({ name: "Route", skipped: 0, cleared: true })).toBe(
      "✓ Route dismissed",
    );
    expect(planDismissedText({ name: "Krait", skipped: 0, cleared: false })).toBe(
      "ⓘ Krait: nothing left to dismiss",
    );
    const p = plan("r", [[]]);
    expect(stepDismissedText({ name: "R", stop: "Port", index: 0, plan: p })).toBe(
      "✓ skipped Port",
    );
    expect(stepDismissedText({ name: "R", stop: null, index: null, plan: p })).toBe(
      "ⓘ R: no stop left to do",
    );
  });
});
