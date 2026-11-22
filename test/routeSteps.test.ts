import type { Plan } from "ed-mcp/journal";
import { describe, expect, it } from "vitest";
import { arrivalCopy, currentSystem, routeStep } from "../src/core/hud/routeSteps.js";

// Listed A, B, C, D; visited C, A, B, D.
const plan = (statuses: ("todo" | "done" | "skipped")[], systems = "ABCD"): Plan => ({
  id: "trip",
  name: "Trip",
  items: [],
  stops: statuses.map((status, i) => ({ system: systems[i]!, purpose: "go", status })),
  route: {
    computed_at: "",
    from: "Here",
    stops: [...systems].filter((_, i) => i < statuses.length),
    total_min: 0,
    plotted: true,
    stop_indexes: [[2], [0], [1], [3]],
  },
  created_at: "",
  updated_at: "",
});

describe("arriving at a stop", () => {
  it("copies the next stop's system on reaching the current stop's system", () => {
    // Current is C (index 2); next in visit order is A.
    expect(arrivalCopy(plan(["todo", "todo", "todo", "todo"]), "C")).toBe("A");
    // Case does not matter.
    expect(arrivalCopy(plan(["todo", "todo", "todo", "todo"]), "c")).toBe("A");
  });

  it("copies nothing elsewhere, at the last stop, or without a plan", () => {
    expect(arrivalCopy(plan(["todo", "todo", "todo", "todo"]), "B")).toBeNull();
    expect(arrivalCopy(plan(["done", "done", "done", "todo"]), "D")).toBeNull();
    expect(arrivalCopy(null, "C")).toBeNull();
    expect(arrivalCopy(plan(["done", "done", "done", "done"]), "D")).toBeNull();
  });
});

describe("route keys", () => {
  it("forward marks the current stop done", () => {
    expect(routeStep(plan(["todo", "todo", "todo", "todo"]), 1)).toEqual({
      update: { index: 2, status: "done" },
    });
  });

  it("back puts the stop done last in visit order back to todo", () => {
    // C then A done: back undoes A.
    expect(routeStep(plan(["done", "todo", "done", "todo"]), -1)).toEqual({
      update: { index: 0, status: "todo" },
    });
  });

  it("says why nothing changes", () => {
    expect(routeStep(null, 1)).toEqual({ notice: "ⓘ no active route plan" });
    expect(routeStep(plan(["done", "done", "done", "done"]), 1)).toEqual({
      notice: "ⓘ route finished",
    });
    expect(routeStep(plan(["todo", "todo", "todo", "todo"]), -1)).toEqual({
      notice: "ⓘ at the first stop",
    });
  });

  it("copies the current stop's system after a step", () => {
    expect(currentSystem(plan(["todo", "todo", "done", "todo"]))).toBe("A");
    expect(currentSystem(plan(["done", "done", "done", "done"]))).toBeNull();
    expect(currentSystem(null)).toBeNull();
  });
});
