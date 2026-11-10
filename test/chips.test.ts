import { describe, expect, it } from "vitest";
import { firstLine, parseChips } from "../src/core/chips.js";
import { HUD_PROMPT } from "../src/core/prompt.js";

describe("parseChips", () => {
  it("numbers marked names and removes the markers", () => {
    expect(parseChips("Go to ⟦Hip 3922⟧, dock at ⟦Prospect Station⟧.")).toEqual({
      plain: "Go to Hip 3922, dock at Prospect Station.",
      chips: [
        { n: 1, text: "Hip 3922" },
        { n: 2, text: "Prospect Station" },
      ],
    });
  });

  it("gives a repeated name one chip", () => {
    expect(parseChips("⟦Sol⟧ then ⟦Sol⟧").chips).toEqual([{ n: 1, text: "Sol" }]);
  });

  it("numbers at most 9 chips", () => {
    const text = Array.from({ length: 11 }, (_, i) => `⟦S${i}⟧`).join(" ");
    const r = parseChips(text);
    expect(r.chips).toHaveLength(9);
    expect(r.plain).toContain("S10");
  });

  it("leaves an unclosed marker while a reply streams", () => {
    expect(parseChips("Go to ⟦Hip 39").plain).toBe("Go to ⟦Hip 39");
  });

  it("drops an empty marker", () => {
    expect(parseChips("a ⟦ ⟧ b")).toEqual({ plain: "a  b", chips: [] });
  });
});

describe("firstLine", () => {
  it("returns the first non-empty line", () => {
    expect(firstLine("\n  Hip 3922, 41 ly \nmore")).toBe("Hip 3922, 41 ly");
    expect(firstLine("  \n")).toBeNull();
  });
});

describe("HUD_PROMPT", () => {
  it("is safe to pass through cmd.exe", () => {
    expect(HUD_PROMPT).not.toMatch(/["%^&|<>]/);
    expect(HUD_PROMPT).toContain("⟦");
  });

  it("tells Claude to use a working ed-mcp when another copy failed", () => {
    expect(HUD_PROMPT).toMatch(/one can fail while the other works/);
    expect(HUD_PROMPT).toMatch(/use them, and do not say that ed-mcp failed/);
    expect(HUD_PROMPT).toMatch(
      /If none are listed, say that the game data tools are not available/,
    );
  });
});
