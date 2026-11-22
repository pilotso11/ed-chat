import path from "node:path";

// How the overlay looks: the colours and the fonts. The renderers read these as CSS variables.

export const THEME_NAMES = ["game", "orange", "blue", "green", "cyan", "white"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const FONT_NAMES = ["standard", "compact"] as const;
export type FontName = (typeof FONT_NAMES)[number];

type Rgb = readonly [number, number, number];
/** Three rows, as in the game: each output channel is a mix of the input red, green and blue. */
export type Matrix = readonly [Rgb, Rgb, Rgb];

const IDENTITY: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * The game recolours its orange HUD with a matrix in GraphicsConfigurationOverride.xml; these
 * are the matrices the overlay's own palette is mixed with, so a theme looks like the same
 * colour in the game.
 */
export const THEME_MATRICES: Record<Exclude<ThemeName, "game">, Matrix> = {
  orange: IDENTITY,
  blue: [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
  ],
  green: [
    [0, 0, 1],
    [1, 0, 0],
    [0, 0, 0],
  ],
  cyan: [
    [0, 0, 1],
    [1, 0, 0],
    [1, 0, 0],
  ],
  white: [
    [0.6, 0.4, 0],
    [0.6, 0.4, 0],
    [0.6, 0.4, 0],
  ],
};

// The overlay's colours, in the game's orange. The theme mixes them.
const ACCENT: Rgb = [255, 179, 71];
const STRONG: Rgb = [255, 140, 0];
const LIGHT: Rgb = [255, 208, 138];
const INK: Rgb = [242, 230, 208];

const mix = (m: Matrix, c: Rgb): Rgb =>
  m.map((row) =>
    Math.max(0, Math.min(255, Math.round(row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))),
  ) as unknown as Rgb;
const hex = (c: Rgb) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const list = (c: Rgb) => c.join(", ");

/**
 * The CSS variables for a theme. Body text takes a little of the colour and stays near white:
 * mixed in full, a green or blue matrix makes it hard to read. The orange theme is the
 * original palette exactly.
 */
export function themeVars(theme: ThemeName, game: Matrix | null): Record<string, string> {
  const m = theme === "game" ? (game ?? IDENTITY) : THEME_MATRICES[theme];
  const orange = m.every((r, i) => r.every((v, j) => v === IDENTITY[i]![j]));
  const tinted = (c: Rgb): Rgb =>
    orange ? c : (mix(m, c).map((v) => Math.round(v * 0.55 + 255 * 0.45)) as unknown as Rgb);
  const ink = tinted(INK);
  const strong = mix(m, STRONG);
  return {
    "--accent": hex(mix(m, ACCENT)),
    "--strong": hex(strong),
    "--strong-rgb": list(strong),
    "--light": hex(mix(m, LIGHT)),
    "--ink": hex(ink),
    "--ink-rgb": list(ink),
  };
}

/** Compact is for a tight overlay: a narrower text face, with the mono face of the same width. */
const FONTS: Record<FontName, { ui: string; mono: string }> = {
  standard: {
    ui: '"Segoe UI", system-ui, sans-serif',
    // Cascadia Mono comes with Windows 11; Windows 10 falls back to Consolas.
    mono: '"Cascadia Mono", Consolas, monospace',
  },
  compact: {
    ui: '"Roboto Condensed", "Segoe UI", system-ui, sans-serif',
    mono: "Consolas, monospace",
  },
};

export function fontVars(font: FontName): Record<string, string> {
  return { "--font-ui": FONTS[font].ui, "--font-mono": FONTS[font].mono };
}

export function lookVars(
  style: { theme: ThemeName; font: FontName },
  game: Matrix | null,
): Record<string, string> {
  return { ...themeVars(style.theme, game), ...fontVars(style.font) };
}

/** The game's colour override: the same folder as DisplaySettings.xml. */
export function graphicsOverrideFile(localAppData: string | undefined, home: string): string {
  return path.join(
    localAppData ?? path.join(home, "AppData", "Local"),
    "Frontier Developments",
    "Elite Dangerous",
    "Options",
    "Graphics",
    "GraphicsConfigurationOverride.xml",
  );
}

function row(xml: string, tag: string): Rgb | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  const v = m[1]!.split(",").map((s) => Number(s.trim()));
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) return null;
  return v as unknown as Rgb;
}

/** The HUD colour matrix in the game's override file; null when there is none to use. */
export function parseHudMatrix(xml: string): Matrix | null {
  const block = /<GUIColour>[\s\S]*?<Default>([\s\S]*?)<\/Default>/i.exec(xml)?.[1];
  if (!block) return null;
  const r = row(block, "MatrixRed");
  const g = row(block, "MatrixGreen");
  const b = row(block, "MatrixBlue");
  return r && g && b ? [r, g, b] : null;
}
