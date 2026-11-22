import { describe, expect, it } from "vitest";
import {
  FONT_NAMES,
  THEME_MATRICES,
  THEME_NAMES,
  fontVars,
  graphicsOverrideFile,
  lookVars,
  parseHudMatrix,
  themeVars,
} from "../src/core/theme.js";

const override = (
  red: string,
  green: string,
  blue: string,
) => `<?xml version="1.0" encoding="UTF-8" ?>
<GraphicsConfig>
    <GUIColour>
        <Default>
            <LocalisationName>Standard</LocalisationName>
   		<MatrixRed>${red}</MatrixRed>
		<MatrixGreen> ${green} </MatrixGreen>
		<MatrixBlue> ${blue} </MatrixBlue>
        </Default>
    </GUIColour>
</GraphicsConfig>`;

describe("themeVars", () => {
  it("keeps the original orange palette for the default theme", () => {
    expect(themeVars("orange", null)).toEqual({
      "--accent": "#ffb347",
      "--strong": "#ff8c00",
      "--strong-rgb": "255, 140, 0",
      "--light": "#ffd08a",
      "--ink": "#f2e6d0",
      "--ink-rgb": "242, 230, 208",
    });
  });

  it("mixes the palette with the theme's matrix", () => {
    const blue = themeVars("blue", null);
    expect(blue["--accent"]).toBe("#47b3ff");
    expect(blue["--strong"]).toBe("#008cff");
    expect(blue["--strong-rgb"]).toBe("0, 140, 255");
  });

  it("keeps body text near white, whatever the colour", () => {
    for (const t of THEME_NAMES.filter((n) => n !== "orange")) {
      const [r, g, b] = themeVars(t, null)["--ink-rgb"]!.split(", ").map(Number);
      expect(Math.min(r!, g!, b!)).toBeGreaterThanOrEqual(115);
    }
  });

  it("gives every theme but orange its own accent", () => {
    const accents = THEME_NAMES.filter((n) => n !== "game").map(
      (n) => themeVars(n, null)["--accent"],
    );
    expect(new Set(accents).size).toBe(accents.length);
  });

  it("follows the game's matrix for the game theme, and is orange without one", () => {
    expect(themeVars("game", THEME_MATRICES.green)).toEqual(themeVars("green", null));
    expect(themeVars("game", null)).toEqual(themeVars("orange", null));
    // The game's own default matrix is the original palette, text included.
    expect(themeVars("game", THEME_MATRICES.orange)).toEqual(themeVars("orange", null));
  });

  it("stays within a colour's range for weights above 1", () => {
    const loud = themeVars("game", [
      [2, 2, 2],
      [2, 2, 2],
      [2, 2, 2],
    ]);
    expect(loud["--accent"]).toBe("#ffffff");
  });
});

describe("fontVars", () => {
  it("pairs each face with a mono face of its own width", () => {
    expect(fontVars("standard")["--font-ui"]).toMatch(/^"Segoe UI"/);
    expect(fontVars("standard")["--font-mono"]).toMatch(/^"Cascadia Mono", Consolas/);
    expect(fontVars("compact")["--font-ui"]).toMatch(/^"Roboto Condensed"/);
    expect(fontVars("compact")["--font-mono"]).toMatch(/^Consolas/);
    expect(FONT_NAMES).toEqual(["standard", "compact"]);
  });

  it("falls back to a system font when the bundled face fails to load", () => {
    expect(fontVars("compact")["--font-ui"]).toContain('"Segoe UI"');
  });
});

describe("lookVars", () => {
  it("is the theme and the fonts together", () => {
    expect(lookVars({ theme: "cyan", font: "compact" }, null)).toEqual({
      ...themeVars("cyan", null),
      ...fontVars("compact"),
    });
  });
});

describe("parseHudMatrix", () => {
  it("reads the game's default matrix", () => {
    expect(parseHudMatrix(override("1, 0, 0 ", "0, 1, 0", "0, 0, 1"))).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it("reads fractions", () => {
    expect(parseHudMatrix(override("0, 0.27, 1", "0.5,1,0", "1, 0, 0"))).toEqual([
      [0, 0.27, 1],
      [0.5, 1, 0],
      [1, 0, 0],
    ]);
  });

  it.each([
    ["an empty file", ""],
    ["no colour section", "<GraphicsConfig></GraphicsConfig>"],
    ["a row of two numbers", override("1, 0", "0, 1, 0", "0, 0, 1")],
    ["a row that is not a number", override("1, x, 0", "0, 1, 0", "0, 0, 1")],
    ["an empty entry, as in a half-edited file", override("1,,0", "0, 1, 0", "0, 0, 1")],
    ["a row of nothing", override(",,", "0, 1, 0", "0, 0, 1")],
    ["a negative weight", override("-1, 0, 0", "0, 1, 0", "0, 0, 1")],
    ["a weight far above 1", override("100, 0, 0", "0, 1, 0", "0, 0, 1")],
    ["a matrix of zeros, which would draw nothing", override("0, 0, 0", "0, 0, 0", "0, 0, 0")],
    [
      "a missing row",
      "<GraphicsConfig><GUIColour><Default><MatrixRed>1,0,0</MatrixRed></Default></GUIColour></GraphicsConfig>",
    ],
  ])("is null for %s", (_, xml) => {
    expect(parseHudMatrix(xml)).toBeNull();
  });

  it("reads the default section, not another colour set", () => {
    const xml = `<GraphicsConfig><GUIColour><Default><MatrixRed>0,0,1</MatrixRed><MatrixGreen>0,1,0</MatrixGreen><MatrixBlue>1,0,0</MatrixBlue></Default><Other><MatrixRed>1,0,0</MatrixRed></Other></GUIColour></GraphicsConfig>`;
    expect(parseHudMatrix(xml)?.[0]).toEqual([0, 0, 1]);
  });
});

describe("graphicsOverrideFile", () => {
  it("is in the game's graphics options folder", () => {
    expect(graphicsOverrideFile("C:\Users\a\AppData\Local", "C:\Users\a")).toMatch(
      /Elite Dangerous.Options.Graphics.GraphicsConfigurationOverride\.xml$/,
    );
  });

  it("finds the folder without LOCALAPPDATA", () => {
    expect(graphicsOverrideFile(undefined, "C:\Users\a")).toContain("AppData");
  });
});
