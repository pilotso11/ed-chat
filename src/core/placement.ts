import type { Position, Settings } from "./settings.js";

// Window sizes and display choice; main measures, places and moves the windows.

export interface Size {
  width: number;
  height: number;
}

/** The chat window: the card width scaled with the font, the content's height. */
export function overlaySize(settings: Settings, contentHeight: number): Size {
  const width = Math.round(settings.card.width * (settings.style.fontSize / 14));
  return { width, height: Math.max(24, Math.ceil(contentHeight)) };
}

/**
 * The activity panel: at least hud.width wide (scaled with its font), wider when its content
 * is, up to the screen's width.
 */
export function hudWindowSize(hud: Settings["hud"], content: Size, areaWidth: number): Size {
  const least = Math.round(hud.width * (hud.fontSize / 15));
  const width = Math.min(areaWidth, Math.max(least, Math.ceil(content.width)));
  return { width, height: Math.max(8, Math.ceil(content.height)) };
}

interface Display {
  id: number;
}

/** The position setting's display for a display: "primary", or its index. */
export function displaySetting(d: Display, all: Display[], primary: Display): Position["display"] {
  return d.id === primary.id
    ? "primary"
    : Math.max(
        0,
        all.findIndex((x) => x.id === d.id),
      );
}

/** The position on the next display, in the order Windows lists them. */
export function onNextDisplay(pos: Position, all: Display[], primary: Display): Position {
  // While a monitor is unplugged Windows can list none for a moment.
  if (!all.length) return pos;
  const now = pos.display === "primary" ? all.findIndex((d) => d.id === primary.id) : pos.display;
  return { ...pos, display: (Math.max(0, now) + 1) % all.length };
}
