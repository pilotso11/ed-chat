import { describe, expect, it } from "vitest";
import { chipLabel, firstLine, parseChips, withTargets } from "../src/core/chips.js";
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

  it("keeps a target after › on the chip, but copies the system", () => {
    expect(parseChips("Land on ⟦Col 285 › 4 d⟧, then ⟦Col 285⟧.")).toEqual({
      plain: "Land on Col 285 4 d, then Col 285.",
      chips: [
        { n: 1, text: "Col 285", detail: "4 d" },
        { n: 2, text: "Col 285" },
      ],
    });
    expect(chipLabel({ n: 1, text: "Col 285", detail: "4 d" })).toBe("Col 285 · 4 d");
  });

  it("takes a chip's target from the first route stop in its system", () => {
    const chips = [
      { n: 1, text: "Col 285" },
      { n: 2, text: "Sol" },
      { n: 3, text: "Col 9", detail: "kept" },
    ];
    const stops = [
      { system: "col 285", body: "Col 285 4 d" },
      { system: "Col 285", body: "5" },
      { system: "Col 9", body: "1" },
    ];
    expect(withTargets(chips, stops)).toEqual([
      { n: 1, text: "Col 285", detail: "4 d" },
      { n: 2, text: "Sol" },
      { n: 3, text: "Col 9", detail: "kept" },
    ]);
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
    // A cmd.exe command line holds at most 8191 characters, and the prompt shares it with the
    // settings instructions, paths and the player's extra arguments.
    expect(HUD_PROMPT.length).toBeLessThan(3500);
  });

  it("tells Claude to use a working ed-mcp when another copy failed", () => {
    expect(HUD_PROMPT).toMatch(/one can fail while the other works/);
    expect(HUD_PROMPT).toMatch(/use them, and do not report the other copy as failed/);
  });

  it("tells Claude to report ed-mcp as down when no tool is listed or a call fails", () => {
    expect(HUD_PROMPT).toMatch(
      /If none are listed, say that the game data tools are not available/,
    );
    expect(HUD_PROMPT).toMatch(/If a call to one fails, say what it reported/);
  });

  it("tells Claude to read and save the activity, mark route stops, and read the journal with ed-mcp", () => {
    expect(HUD_PROMPT).toMatch(/if activity_get is listed, call it/);
    expect(HUD_PROMPT).toMatch(/save it with activity_set if it is listed/);
    expect(HUD_PROMPT).toMatch(
      /do not assume the player is following a plan unless the journal shows it/,
    );
    expect(HUD_PROMPT).toMatch(/answer from the recent journal events/);
    expect(HUD_PROMPT).toMatch(/say so once in the conversation, with its age in hours/);
    expect(HUD_PROMPT).toMatch(/name each missing item and how many are short/);
    expect(HUD_PROMPT).toMatch(/total materials for every grade and roll still needed/);
    expect(HUD_PROMPT).toMatch(/mark it with plan_update_stop if it is listed/);
    expect(HUD_PROMPT).toMatch(
      /If ed-mcp journal tools are listed, read the game journal with them, not with shell commands/,
    );
  });
});
