import type { Foreground } from "../focus.js";
import { HUD_MODES, keyList, type Settings } from "../settings.js";
import type { SavedState } from "../stores.js";
import type { FeedData } from "./feed.js";
import type { HudInput, HudView } from "./hud.js";
import { cycleMode } from "./mode.js";

// What the activity panel shows and when, from the feed, the saved state and the settings;
// main sends the view and shows or hides the window.

/** The mode chosen with the hotkey, as the mode choice reads it. */
export function hotkeyChoice(saved: SavedState): HudInput["hotkey"] {
  return saved.hudMode ? { mode: saved.hudMode.mode, at: Date.parse(saved.hudMode.at) } : null;
}

/** The panel's input: the feed's data, or nothing from the game before its first read. */
export function hudInput(
  data: FeedData | null,
  saved: SavedState,
  hud: Settings["hud"],
  now: number,
): HudInput {
  return {
    journal: null,
    status: null,
    nav: null,
    activity: null,
    plan: null,
    samples: new Map(),
    known: null,
    ...data,
    hotkey: hotkeyChoice(saved),
    settings: hud,
    now,
  };
}

/** While the move keys move the panel: what to press. */
export function moveHint(hotkeys: Settings["hotkeys"]): string {
  const first = (x: Parameters<typeof keyList>[0]) => keyList(x)[0];
  return (
    `Move panel: ${first(hotkeys.moveUp)} / ${first(hotkeys.moveDown)} / ` +
    `${first(hotkeys.moveLeft)} / ${first(hotkeys.moveRight)} · monitor ${first(hotkeys.nextDisplay)}`
  );
}

/**
 * Whether the panel can be seen now, whatever it shows: on, not hidden, and over the game, like the
 * hotkeys in game scope. Spansh searches and clipboard copies wait for it.
 */
export function hudCanShow(
  hud: Settings["hud"],
  saved: SavedState,
  foreground: Foreground | null,
): boolean {
  const f = foreground;
  const gameUp = !f || f.isGame || f.isOverlay;
  return hud.enabled && !saved.hudHidden && gameUp;
}

/** Shown when it can be (hudCanShow(), worked out once per render), with something to show. */
export function hudVisible(canShow: boolean, view: HudView, moving: boolean): boolean {
  return canShow && (view.panel !== null || view.route !== null || moving);
}

/**
 * The mode hotkey: the next enabled mode, then off, then automatic again. Choosing a mode
 * also shows a hidden panel.
 */
export function nextHudMode(
  saved: SavedState,
  hud: Settings["hud"],
  now: Date,
): { saved: SavedState; mode: string } {
  const enabled = HUD_MODES.filter((m) => hud.modes[m]);
  const next = cycleMode(saved.hudMode?.mode ?? "auto", enabled);
  const { hudMode: _m, ...rest } = saved;
  return {
    mode: next,
    saved:
      next === "auto"
        ? { ...rest, hudHidden: false }
        : { ...rest, hudHidden: false, hudMode: { mode: next, at: now.toISOString() } },
  };
}

/**
 * The galaxy-map copy the panel asks for, if it is new: copied only while the panel can be seen,
 * and once per key. `copied` is the key copied last; it is kept through gaps (a hidden panel, a
 * hold no longer full, a search in progress), so the same trip is not copied again.
 */
export function panelCopy(
  view: HudView,
  canShow: boolean,
  copied: string | null,
): { copy: { text: string; note: string } | null; copied: string | null } {
  const c = canShow ? (view.panel?.copy ?? null) : null;
  if (!c) return { copy: null, copied };
  return { copy: c.key === copied ? null : { text: c.text, note: c.note }, copied: c.key };
}
