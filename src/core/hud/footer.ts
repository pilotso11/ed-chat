import type { Tone } from "./panels.js";

// The panel's footer lines, apart from panels.ts so the renderer reads them without the panel code.

/** A footer line: its text, or its text and a tone. */
export type FooterLine = string | { text: string; tone?: Tone };

/** A footer line's text. */
export const footerText = (f: FooterLine) => (typeof f === "string" ? f : f.text);

/** A footer line's tone, if it has one. */
export const footerTone = (f: FooterLine) => (typeof f === "string" ? undefined : f.tone);
