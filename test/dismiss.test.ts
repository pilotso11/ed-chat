import type { Plan } from "ed-mcp/journal";
import { describe, expect, it, vi } from "vitest";
import { dismissPlan, dismissText, type Dismissed } from "../src/core/hud/dismiss.js";

const plan = (id: string, statuses: string[][]): Plan =>
  ({
    id,
    name: `${id} plan`,
    items: [],
    stops: statuses.map((s, i) => ({
      system: "S",
      station: `P${i}`,
      kind: "shop",
      status: "todo",
      actions: s.map((status, j) => ({ id: `a${i}${j}`, kind: "buy_module", label: "x", status })),
    })),
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
  }) as unknown as Plan;

/** The store: each plan's list summary counts its actions, done or skipped ones as done. */
const deps = (plans: Plan[], cleared = true) => {
  const summary = (p: Plan) => {
    const all = p.stops.flatMap((s) => s.actions ?? []);
    return {
      id: p.id,
      name: p.name,
      items: 0,
      done: 0,
      ...(all.length > 0
        ? {
            actions: all.length,
            actions_done: all.filter((a) => a.status === "done" || a.status === "skipped").length,
          }
        : {}),
      next_stop: null,
      updated_at: p.updated_at,
    };
  };
  return {
    activity: { clear: vi.fn(async () => cleared) },
    plans: {
      list: vi.fn(async () => plans.map(summary)),
      get: vi.fn(async (id: string) => plans.find((p) => p.id === id)!),
      updateAction: vi.fn(async () => ({}) as Plan),
    },
  };
};

const none: Dismissed = { cleared: false, open: [], skipped: [], failed: [], forget: [] };

describe("dismissPlan", () => {
  it("clears the activity note and leaves the plans alone, naming the open ones", async () => {
    const d = deps([plan("krait", [["todo"]]), plan("route", []), plan("old", [["done"]])]);
    const r = await dismissPlan(d, false);
    expect(r).toEqual({ ...none, cleared: true, open: ["krait plan"] });
    expect(d.activity.clear).toHaveBeenCalledOnce();
    expect(d.plans.updateAction).not.toHaveBeenCalled();
  });

  it("with all, skips every open action, as the store has it, and leaves done and skipped ones", async () => {
    const krait = plan("krait", [["done", "todo"], ["skipped"], ["in_progress"]]);
    const finished = plan("old", [["done"]]);
    const d = deps([krait, finished, plan("route", [])]);
    // The store's copy is read: an action done since the list is not marked skipped.
    const fresh = plan("krait", [["done", "done"], ["skipped"], ["in_progress"]]);
    d.plans.get.mockImplementation(async (id) => (id === "krait" ? fresh : finished));
    const r = await dismissPlan(d, true);
    expect(r).toEqual({
      ...none,
      cleared: true,
      skipped: ["krait plan"],
      forget: ["krait", "old"],
    });
    expect(d.plans.get.mock.calls).toEqual([["krait"]]);
    expect(d.plans.updateAction.mock.calls).toEqual([
      ["krait", { stop: { index: 2 }, action: "a20" }, { status: "skipped" }],
    ]);
  });

  it("goes on after a plan whose write fails, and says which", async () => {
    const d = deps([plan("a", [["todo"]]), plan("b", [["todo"]])]);
    d.plans.updateAction.mockRejectedValueOnce(new Error("locked"));
    const r = await dismissPlan(d, true);
    expect(r.skipped).toEqual(["b plan"]);
    expect(r.failed).toEqual([{ name: "a plan", error: "locked" }]);
    expect(r.forget).toEqual(["a", "b"]);
  });
});

describe("dismissText", () => {
  it("says what was dismissed and what is left", () => {
    expect(dismissText({ ...none, cleared: true, skipped: ["krait plan"] }, true)).toBe(
      "✓ plan dismissed; skipped what was left of krait plan",
    );
    expect(dismissText({ ...none, cleared: true }, true)).toBe("✓ plan dismissed");
    expect(dismissText({ ...none, cleared: true }, false)).toBe("✓ plan dismissed");
    expect(dismissText({ ...none, cleared: true, open: ["krait plan"] }, false)).toBe(
      "✓ plan dismissed; krait plan still shows at its stops: /dismiss-plan all",
    );
    expect(dismissText({ ...none, open: ["a", "b"] }, false)).toBe(
      "ⓘ no activity plan; a, b still show at their stops: /dismiss-plan all",
    );
    expect(dismissText(none, false)).toBe("ⓘ no plan to dismiss");
    expect(
      dismissText(
        { ...none, cleared: true, skipped: ["b"], failed: [{ name: "a", error: "locked" }] },
        true,
      ),
    ).toBe(
      "⚠ plan dismissed; skipped what was left of b; could not skip all that was left of a (locked)",
    );
    expect(dismissText({ ...none, forget: ["old"] }, true)).toBe("✓ nothing left to skip");
  });
});
