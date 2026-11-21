import { describe, expect, it } from "vitest";
import { coverageBadge } from "../scripts/coverage-badge.js";

const summary = (pct: number) => ({ total: { lines: { pct } } });

describe("coverageBadge", () => {
  it("gives the line coverage, rounded down", () => {
    expect(coverageBadge(summary(67.92))).toEqual({ label: "coverage", message: "67%" });
    expect(coverageBadge(summary(100))).toEqual({ label: "coverage", message: "100%" });
  });

  it("refuses a summary with no line coverage", () => {
    expect(() => coverageBadge({ total: { lines: {} } } as never)).toThrow("no line coverage");
  });
});
