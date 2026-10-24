import { describe, expect, it } from "vitest";
import { chooseDisplay, column, growsUp, place, snap, step } from "../src/core/anchor.js";

describe("step", () => {
  it.each([
    ["top-right", "left", "top"],
    ["top", "left", "top-left"],
    ["top-right", "down", "right"],
    ["right", "down", "bottom-right"],
    ["top", "down", "bottom"],
    ["left", "right", "right"],
    ["top-left", "up", "top-left"],
    ["top-left", "left", "top-left"],
    ["bottom-right", "right", "bottom-right"],
  ] as const)("%s + %s = %s", (from, dir, to) => {
    expect(step(from, dir)).toBe(to);
  });
});

describe("place", () => {
  const area = { x: 0, y: 40, width: 1920, height: 1040 };
  const size = { width: 420, height: 70 };
  it.each([
    ["top-left", { x: 24, y: 64 }],
    ["top", { x: 750, y: 64 }],
    ["top-right", { x: 1476, y: 64 }],
    ["left", { x: 24, y: 525 }],
    ["right", { x: 1476, y: 525 }],
    ["bottom-left", { x: 24, y: 986 }],
    ["bottom", { x: 750, y: 986 }],
    ["bottom-right", { x: 1476, y: 986 }],
  ] as const)("%s", (anchor, xy) => {
    expect(place(anchor, 24, 24, area, size)).toEqual(xy);
  });

  it("uses the display's origin", () => {
    expect(place("top-left", 10, 10, { x: -1920, y: 0, width: 1920, height: 1080 }, size)).toEqual({
      x: -1910,
      y: 10,
    });
  });
});

describe("growsUp", () => {
  it("is true only for bottom anchors", () => {
    expect(growsUp("bottom-left")).toBe(true);
    expect(growsUp("bottom")).toBe(true);
    expect(growsUp("right")).toBe(false);
    expect(growsUp("top")).toBe(false);
  });
});

describe("chooseDisplay", () => {
  it("picks by index, else the primary", () => {
    expect(chooseDisplay(["a", "b"], "a", 1)).toBe("b");
    expect(chooseDisplay(["a", "b"], "a", 5)).toBe("a");
    expect(chooseDisplay(["a", "b"], "b", "primary")).toBe("b");
  });
});

describe("column", () => {
  it("names the anchor's column", () => {
    expect(column("bottom-left")).toBe("left");
    expect(column("left")).toBe("left");
    expect(column("top")).toBe("center");
    expect(column("bottom")).toBe("center");
    expect(column("right")).toBe("right");
    expect(column("top-right")).toBe("right");
  });
});

describe("snap", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const win = (x: number, y: number) => ({ x, y, width: 420, height: 70 });
  it.each([
    [win(30, 990), { anchor: "bottom-left", offsetX: 30, offsetY: 20 }],
    [win(1470, 40), { anchor: "top-right", offsetX: 30, offsetY: 40 }],
    [win(750, 40), { anchor: "top", offsetX: 0, offsetY: 40 }],
    [win(30, 505), { anchor: "left", offsetX: 30, offsetY: 0 }],
    // The center cell has no anchor; the nearest edge wins.
    [win(760, 480), { anchor: "top", offsetX: 0, offsetY: 480 }],
    [win(-50, -10), { anchor: "top-left", offsetX: 0, offsetY: 0 }],
  ] as const)("%o", (rect, expected) => {
    expect(snap(rect, area)).toEqual(expected);
  });

  it("measures from the display's origin", () => {
    expect(snap(win(1950, 30), { x: 1920, y: 0, width: 1920, height: 1080 })).toEqual({
      anchor: "top-left",
      offsetX: 30,
      offsetY: 30,
    });
  });
});
