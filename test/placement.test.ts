import { describe, expect, it } from "vitest";
import {
  displaySetting,
  hudWindowSize,
  onNextDisplay,
  overlaySize,
} from "../src/core/placement.js";
import { DEFAULT_SETTINGS, type Position } from "../src/core/settings.js";

const s = DEFAULT_SETTINGS;

describe("chat window size", () => {
  it("scales the card width with the font, from 14 px", () => {
    expect(overlaySize(s, 100)).toEqual({ width: 420, height: 100 });
    const big = { ...s, style: { ...s.style, fontSize: 21 } };
    expect(overlaySize(big, 100).width).toBe(630);
  });

  it("rounds the content height up, and is never shorter than 24", () => {
    expect(overlaySize(s, 100.2).height).toBe(101);
    expect(overlaySize(s, 0).height).toBe(24);
  });
});

describe("panel window size", () => {
  const hud = s.hud; // 380 wide at 15 px

  it("is at least the set width, scaled with the panel's font", () => {
    expect(hudWindowSize(hud, { width: 100, height: 50 }, 1920)).toEqual({
      width: 380,
      height: 50,
    });
    expect(hudWindowSize({ ...hud, fontSize: 30 }, { width: 0, height: 0 }, 1920).width).toBe(760);
  });

  it("grows with its content, up to the screen's width", () => {
    expect(hudWindowSize(hud, { width: 500.4, height: 50 }, 1920).width).toBe(501);
    expect(hudWindowSize(hud, { width: 3000, height: 50 }, 1920).width).toBe(1920);
    // A narrow screen wins over the set width too.
    expect(hudWindowSize(hud, { width: 0, height: 0 }, 300).width).toBe(300);
  });

  it("rounds the height up, and is never shorter than 8", () => {
    expect(hudWindowSize(hud, { width: 0, height: 40.1 }, 1920).height).toBe(41);
    expect(hudWindowSize(hud, { width: 0, height: 0 }, 1920).height).toBe(8);
  });
});

describe("displays", () => {
  const a = { id: 10 };
  const b = { id: 20 };
  const c = { id: 30 };
  const pos = (display: Position["display"]): Position => ({
    ...s.position,
    display,
  });

  it("names the primary display as primary, and the others by index", () => {
    expect(displaySetting(b, [a, b, c], b)).toBe("primary");
    expect(displaySetting(c, [a, b, c], b)).toBe(2);
    // A display no longer listed counts as the first.
    expect(displaySetting({ id: 99 }, [a, b, c], b)).toBe(0);
  });

  it("moves to the next display in Windows' order, and back to the first", () => {
    expect(onNextDisplay(pos("primary"), [a, b, c], b).display).toBe(2);
    expect(onNextDisplay(pos(2), [a, b, c], b).display).toBe(0);
    expect(onNextDisplay(pos(0), [a, b, c], b).display).toBe(1);
    // Only the display changes.
    expect(onNextDisplay(pos(0), [a, b, c], b)).toEqual({ ...pos(0), display: 1 });
  });

  it("starts from the first display when the primary is not listed", () => {
    expect(onNextDisplay(pos("primary"), [a, c], b).display).toBe(1);
  });
});
