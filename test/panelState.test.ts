import { describe, expect, it } from "vitest";
import type { Foreground } from "../src/core/focus.js";
import type { HudView } from "../src/core/hud/hud.js";
import {
  hotkeyChoice,
  hudInput,
  hudCanShow,
  hudVisible,
  moveHint,
  nextHudMode,
  panelCopy,
} from "../src/core/hud/panelState.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const hud = DEFAULT_SETTINGS.hud;

describe("panel input", () => {
  it("reads nothing from the game before the feed's first read", () => {
    const input = hudInput(null, {}, hud, 1234);
    expect(input).toEqual({
      journal: null,
      status: null,
      nav: null,
      activity: null,
      plan: null,
      samples: new Map(),
      known: null,
      hotkey: null,
      settings: hud,
      now: 1234,
    });
  });

  it("takes the feed's data and the mode chosen with the hotkey", () => {
    const at = "2026-11-21T10:00:00.000Z";
    const input = hudInput(
      {
        journal: null,
        status: null,
        nav: null,
        activity: null,
        plan: null,
        samples: new Map([["x", []]]),
        known: [],
      },
      { hudMode: { mode: "massacre", at } },
      hud,
      5,
    );
    expect(input.samples.size).toBe(1);
    expect(input.known).toEqual([]);
    expect(input.hotkey).toEqual({ mode: "massacre", at: Date.parse(at) });
  });

  it("has no hotkey choice when the mode is automatic", () => {
    expect(hotkeyChoice({})).toBeNull();
  });
});

describe("move hint", () => {
  it("names the first key of each move action", () => {
    expect(moveHint(DEFAULT_SETTINGS.hotkeys)).toBe(
      "Move panel: Ctrl+Alt+Up / Ctrl+Alt+Down / Ctrl+Alt+Left / Ctrl+Alt+Right · monitor Ctrl+Alt+M",
    );
    const listed = { ...DEFAULT_SETTINGS.hotkeys, moveUp: ["F1", "F2"] };
    expect(moveHint(listed)).toMatch(/^Move panel: F1 \/ /);
  });
});

describe("panel visibility", () => {
  const view = (o: Partial<HudView> = {}): HudView => ({
    panel: null,
    route: null,
    moving: null,
    fontSize: 15,
    backgroundOpacity: 0.5,
    width: 380,
    ...o,
  });
  const panel = view({
    panel: { mode: "exploration", title: "EXPLORATION", rows: [], footer: [] },
  });
  const fg = (o: Partial<Foreground>): Foreground => ({
    hwnd: 1,
    isGame: false,
    isOverlay: false,
    processName: null,
    ...o,
  });

  it("shows a panel over the game, over the overlay, or before focus is known", () => {
    expect(hudVisible(hudCanShow(hud, {}, fg({ isGame: true })), panel, false)).toBe(true);
    expect(hudVisible(hudCanShow(hud, {}, fg({ isOverlay: true })), panel, false)).toBe(true);
    expect(hudVisible(hudCanShow(hud, {}, null), panel, false)).toBe(true);
  });

  it("hides over other apps", () => {
    expect(hudVisible(hudCanShow(hud, {}, fg({})), panel, false)).toBe(false);
  });

  it("hides when turned off, or hidden with the hotkey", () => {
    expect(hudVisible(hudCanShow({ ...hud, enabled: false }, {}, null), panel, false)).toBe(false);
    expect(hudVisible(hudCanShow(hud, { hudHidden: true }, null), panel, false)).toBe(false);
  });

  it("shows with a route, or while it moves, and hides with nothing to show", () => {
    expect(hudVisible(true, view(), false)).toBe(false);
    expect(hudVisible(true, view({ route: [] }), false)).toBe(true);
    expect(hudVisible(true, view(), true)).toBe(true);
  });
});

describe("mode hotkey", () => {
  const now = new Date("2026-11-21T12:00:00.000Z");

  it("goes from automatic through each enabled mode to off and back", () => {
    let saved = {};
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      const next = nextHudMode(saved, hud, now);
      seen.push(next.mode);
      saved = next.saved;
    }
    expect(seen).toEqual([
      "massacre",
      "exploration",
      "exobiology",
      "mining",
      "passenger",
      "route",
      "off",
      "auto",
    ]);
    expect(saved).toEqual({ hudHidden: false });
  });

  it("skips modes that are turned off", () => {
    const some = { ...hud, modes: { ...hud.modes, massacre: false, exploration: false } };
    expect(nextHudMode({}, some, now).mode).toBe("exobiology");
  });

  it("records the choice and its time, and shows a hidden panel", () => {
    expect(nextHudMode({ hudHidden: true, iconMode: true }, hud, now).saved).toEqual({
      iconMode: true,
      hudHidden: false,
      hudMode: { mode: "massacre", at: now.toISOString() },
    });
  });
});

describe("galaxy-map copy", () => {
  const copy = (key: string) => ({ key, text: "Ngalinn", note: "n" });

  it("copies a new key once, only while the panel can be seen", () => {
    const first = panelCopy(copy("hold-full|"), true, null);
    expect(first.copy).toEqual({ text: "Ngalinn", note: "n" });
    expect(panelCopy(copy("hold-full|"), true, first.copied).copy).toBeNull();
    expect(panelCopy(copy("hold-full|"), false, null)).toEqual({ copy: null, copied: null });
  });

  it("keeps the last key while hidden and through a gap, and copies the next trip", () => {
    expect(panelCopy(copy("hold-full|"), false, "hold-full|")).toEqual({
      copy: null,
      copied: "hold-full|",
    });
    const gap = panelCopy(null, true, "hold-full|");
    expect(gap).toEqual({ copy: null, copied: "hold-full|" });
    expect(panelCopy(copy("hold-full|"), true, gap.copied).copy).toBeNull();
    expect(panelCopy(copy("hold-full|2026"), true, gap.copied).copy).not.toBeNull();
  });
});
