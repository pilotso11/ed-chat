import { describe, expect, it } from "vitest";
import {
  MAX_HEIGHT,
  answerArg,
  boolArg,
  capLines,
  chipArg,
  describeUnknown,
  heightArg,
  hotkeysWanted,
  textArg,
} from "../src/main/guards.js";

const fg = (isGame: boolean, isOverlay: boolean) => ({
  hwnd: 1,
  isGame,
  isOverlay,
  processName: null,
});

describe("hotkeysWanted", () => {
  it("is always on for scope always", () => {
    expect(hotkeysWanted("always", null)).toBe(true);
    expect(hotkeysWanted("always", fg(false, false))).toBe(true);
  });
  it("follows the game or the overlay for scope game", () => {
    expect(hotkeysWanted("game", fg(true, false))).toBe(true);
    expect(hotkeysWanted("game", fg(false, true))).toBe(true);
    expect(hotkeysWanted("game", fg(false, false))).toBe(false);
  });
  it("is off for scope game without focus tracking", () => {
    expect(hotkeysWanted("game", null)).toBe(false);
  });
});

describe("IPC argument guards", () => {
  it("accepts only strings as text", () => {
    expect(textArg("hi")).toBe("hi");
    expect(textArg(3)).toBeNull();
    expect(textArg({ trim: 1 })).toBeNull();
  });
  it("accepts only positive integers as chip numbers", () => {
    expect(chipArg(2)).toBe(2);
    expect(chipArg(0)).toBeNull();
    expect(chipArg(1.5)).toBeNull();
    expect(chipArg("1")).toBeNull();
  });
  it("accepts only booleans as hover flags", () => {
    expect(boolArg(true)).toBe(true);
    expect(boolArg(false)).toBe(false);
    expect(boolArg(1)).toBeNull();
    expect(boolArg("true")).toBeNull();
  });
  it("accepts only the three approval answers", () => {
    for (const a of ["approve", "deny", "alwaysAllow"]) expect(answerArg(a)).toBe(a);
    for (const bad of ["allow", "Approve", "", 1, null, undefined, {}])
      expect(answerArg(bad)).toBeNull();
  });
  it("rejects bad heights and caps large ones", () => {
    expect(heightArg(120.5)).toBe(120.5);
    expect(heightArg(Number.NaN)).toBeNull();
    expect(heightArg(Infinity)).toBeNull();
    expect(heightArg(-1)).toBeNull();
    expect(heightArg("10")).toBeNull();
    expect(heightArg(1e9)).toBe(MAX_HEIGHT);
  });
});

describe("describeUnknown", () => {
  it("drops hook events", () => {
    expect(
      describeUnknown({ type: "system", subtype: "hook_response", output: "secret prompt" }),
    ).toBeNull();
  });
  it("logs only type and subtype, never the payload", () => {
    const d = describeUnknown({ type: "future", subtype: "x", text: "secret prompt" });
    expect(d).toBe("type=future subtype=x");
    expect(describeUnknown({ type: "system", subtype: "status" })).toBe(
      "type=system subtype=status",
    );
  });
  it("logs only the length of a non-JSON line", () => {
    expect(describeUnknown("secret prompt")).toBe("non-JSON line (13 chars)");
  });
  it("handles non-objects", () => {
    expect(describeUnknown(42)).toBe("non-object number");
  });
});

describe("capLines", () => {
  it("cuts long lines and keeps short ones", () => {
    const out = capLines(["short", "x".repeat(200)], 10);
    expect(out).toEqual(["short", `${"x".repeat(10)}…`]);
  });
});
