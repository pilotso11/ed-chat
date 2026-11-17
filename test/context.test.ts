import { describe, expect, it } from "vitest";
import { gameContext, withGameContext } from "../src/core/hud/context.js";
import type { HudView } from "../src/core/hud/hud.js";

const view: HudView = {
  panel: {
    mode: "exobiology",
    title: "EXOBIOLOGY",
    subtitle: "5",
    right: "2 genera",
    rows: [
      { text: "Stratum Tectonicas", right: "✓  19.0M", tone: "good" },
      { text: "Bacterium Cerbrus", right: "1/3  1.7M", tone: "accent" },
    ],
    footer: ["Unsold: 1.2M cartographic"],
  },
  route: [
    { kind: "current", text: "Wredguia WJ-H d10-14", right: "4 jumps" },
    { kind: "next", text: "Col 285" },
  ],
  moving: null,
  fontSize: 15,
  backgroundOpacity: 0.55,
  width: 380,
};

describe("game note", () => {
  it("says where the player is, what the panel shows and the route", () => {
    const note = gameContext(
      { system: "HIP 68111", station: null, docked: false },
      { body: "HIP 68111 5", latitude: 1, longitude: 2, radius: 3 },
      view,
    )!;
    expect(note).toContain("Location: in HIP 68111, near HIP 68111 5.");
    expect(note).toContain("Panel: EXOBIOLOGY · 5 · 2 genera");
    expect(note).toContain("- Stratum Tectonicas · ✓  19.0M");
    expect(note).toContain("Route: now Wredguia WJ-H d10-14 4 jumps; next Col 285");
    expect(withGameContext("where next?", note)).toBe(`${note}\n\nwhere next?`);
  });

  it("names the station when docked, and sends the message alone when nothing is known", () => {
    expect(
      gameContext({ system: "Sol", station: "Abraham Lincoln", docked: true }, null, null),
    ).toContain("Location: docked at Abraham Lincoln in Sol.");
    expect(gameContext(null, null, null)).toBeNull();
    expect(withGameContext("hi", null)).toBe("hi");
  });
});
