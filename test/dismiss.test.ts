import type { Plan } from "ed-mcp/journal";
import { describe, expect, it, vi } from "vitest";
import { dismissPlan, dismissText } from "../src/core/hud/dismiss.js";

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

const deps = (cleared = true) => ({
  activity: { clear: vi.fn(async () => cleared) },
  plans: { updateAction: vi.fn(async () => ({}) as Plan) },
});

describe("dismissPlan", () => {
  it("clears the activity note and leaves the plans alone", async () => {
    const d = deps();
    const r = await dismissPlan(d, [plan("krait", [["todo"]])], false);
    expect(r).toEqual({ cleared: true, skipped: [] });
    expect(d.activity.clear).toHaveBeenCalledOnce();
    expect(d.plans.updateAction).not.toHaveBeenCalled();
  });

  it("with all, skips every open action and leaves done and skipped ones", async () => {
    const d = deps();
    const krait = plan("krait", [["done", "todo"], ["skipped"], ["in_progress"]]);
    const finished = plan("done", [["done"]]);
    const r = await dismissPlan(d, [krait, finished], true);
    expect(r.skipped).toEqual([krait]);
    expect(d.plans.updateAction.mock.calls).toEqual([
      ["krait", { stop: { index: 0 }, action: "a01" }, { status: "skipped" }],
      ["krait", { stop: { index: 2 }, action: "a20" }, { status: "skipped" }],
    ]);
  });

  it("passes on a failed write, so the command says it", async () => {
    const d = deps();
    d.plans.updateAction.mockRejectedValueOnce(new Error("locked"));
    await expect(dismissPlan(d, [plan("krait", [["todo"]])], true)).rejects.toThrow("locked");
  });
});

describe("dismissText", () => {
  it("names the plans skipped, or says what is left", () => {
    expect(dismissText({ cleared: true, skipped: [plan("krait", [])] }, true)).toBe(
      "✓ plan dismissed; skipped what was left of krait plan",
    );
    expect(dismissText({ cleared: true, skipped: [] }, true)).toBe("✓ plan dismissed");
    expect(dismissText({ cleared: true, skipped: [] }, false)).toMatch(/\/dismiss-plan all/);
    expect(dismissText({ cleared: false, skipped: [] }, false)).toBe(
      "ⓘ no activity plan to dismiss",
    );
    expect(dismissText({ cleared: false, skipped: [] }, true)).toBe("ⓘ no plan to dismiss");
  });
});
