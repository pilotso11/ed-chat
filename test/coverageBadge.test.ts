import { describe, expect, it } from "vitest";
import { coverageBadge } from "../scripts/coverage-badge.js";

const summary = (pct: number) => ({ total: { lines: { pct } } });

describe("coverageBadge", () => {
  it("gives the line coverage, rounded down", () => {
    expect(coverageBadge(summary(67.92))).toEqual({ message: "67%" });
    expect(coverageBadge(summary(100))).toEqual({ message: "100%" });
  });

  it("refuses a summary with no line coverage", () => {
    for (const bad of [null, {}, { total: {} }, { total: { lines: {} } }, summary(NaN)])
      expect(() => coverageBadge(bad)).toThrow("no line coverage");
  });
});
