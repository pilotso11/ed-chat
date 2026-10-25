import type { Anchor } from "./settings.js";

export type Direction = "up" | "down" | "left" | "right";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GRID: (Anchor | null)[][] = [
  ["top-left", "top", "top-right"],
  ["left", null, "right"],
  ["bottom-left", "bottom", "bottom-right"],
];

const DELTA: Record<Direction, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

function cell(a: Anchor): [number, number] {
  for (let r = 0; r < 3; r++) {
    const c = GRID[r]!.indexOf(a);
    if (c >= 0) return [r, c];
  }
  throw new Error(`unknown anchor ${a}`);
}

// The center cell is skipped: an overlay there would cover the reticle.
export function step(anchor: Anchor, dir: Direction): Anchor {
  let [r, c] = cell(anchor);
  const [dr, dc] = DELTA[dir];
  for (;;) {
    r += dr;
    c += dc;
    if (r < 0 || r > 2 || c < 0 || c > 2) return anchor;
    const next = GRID[r]![c];
    if (next) return next;
  }
}

export function place(
  anchor: Anchor,
  offsetX: number,
  offsetY: number,
  area: Rect,
  size: { width: number; height: number },
): { x: number; y: number } {
  const [r, c] = cell(anchor);
  const x =
    c === 0
      ? area.x + offsetX
      : c === 2
        ? area.x + area.width - size.width - offsetX
        : area.x + (area.width - size.width) / 2;
  const y =
    r === 0
      ? area.y + offsetY
      : r === 2
        ? area.y + area.height - size.height - offsetY
        : area.y + (area.height - size.height) / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

export function growsUp(anchor: Anchor): boolean {
  return anchor.startsWith("bottom");
}

export function column(anchor: Anchor): "left" | "center" | "right" {
  const c = cell(anchor)[1];
  return c === 0 ? "left" : c === 2 ? "right" : "center";
}

export function chooseDisplay<T>(all: T[], primary: T, which: "primary" | number): T {
  return which === "primary" ? primary : (all[which] ?? primary);
}

/** The anchor and offsets that put a window dropped at `win` back where it is. */
export function snap(win: Rect, area: Rect): { anchor: Anchor; offsetX: number; offsetY: number } {
  const left = win.x - area.x;
  const right = area.x + area.width - (win.x + win.width);
  const top = win.y - area.y;
  const bottom = area.y + area.height - (win.y + win.height);
  const third = (v: number, size: number) => (v < size / 3 ? 0 : v >= (2 * size) / 3 ? 2 : 1);
  let c = third(left + win.width / 2, area.width);
  let r = third(top + win.height / 2, area.height);
  // The center cell has no anchor, so the nearest edge decides.
  if (r === 1 && c === 1) {
    const nearest = Math.min(top, bottom, left, right);
    if (nearest === top) r = 0;
    else if (nearest === bottom) r = 2;
    else if (nearest === left) c = 0;
    else c = 2;
  }
  const off = (v: number) => Math.max(0, Math.round(v));
  return {
    anchor: GRID[r]![c]!,
    offsetX: c === 0 ? off(left) : c === 2 ? off(right) : 0,
    offsetY: r === 0 ? off(top) : r === 2 ? off(bottom) : 0,
  };
}
